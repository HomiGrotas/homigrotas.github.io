---
layout: post
title: "University Student Union — IDOR & Client-Side Price Tampering"
date: 2024-11-04
category: web
tags: [idor, cookie-tampering, business-logic, pii-leak]
severity: high
excerpt: "A casual trip to the student union's website turned into two findings: an IDOR exposing full student PII by ID, and cookie tampering that lets any student set their own payable price to zero."
---

# University Student Union — IDOR & Cookie Tampering

> **Status note:** this research is **not fully documented**, because I have not yet verified with the university staff that the vulnerabilities were closed. Findings below were confirmed at the time of testing against the production website.

## The research goal

Honestly? This one wasn't planned. I needed to pay a bill on my student union's website and the payment flow immediately felt off. Curiosity won.

## Finding 1 — IDOR: student data exposure

The website validates discount coupons by sending the **student ID** to an API endpoint, which replies with the full student record and the *reason* the coupon was granted.

The ID is the only input, and the API performs **no ownership check** — any valid student ID returns that student's data. This is a textbook **Insecure Direct Object Reference (IDOR / CWE-639)**: the object reference (student ID) is used directly to retrieve the resource, with no authorization layer.

### Data exposed per student

- City
- Country
- Street address
- Birthdate
- First name
- Last name
- Email address
- Phone number
- ZIP code
- Reminder date
- **Reason for receiving the coupon** — this is the sensitive one (see below)

### Impact analysis

Most of the fields are run-of-the-mill PII. But the **coupon reason** field elevates this from "data leak" to "harassment and blackmail material":

- It reveals **financial vulnerability** (the *economic reason* a student was granted aid).
- Attackers could target low-income students with **phishing campaigns** crafted around their aid status.
- The combination of home address, birthdate, phone, and email is a complete profile for identity theft or targeted social engineering.

Worse, the IDOR was silently exposed on a public website — no authentication at all was required to query arbitrary IDs.

## Finding 2 — Cookie tampering: setting your own price

The payment flow was even more interesting. After the website performs a discount lookup, it writes the computed price into a cookie. The server **never re-validates** that value on the payment-confirmation request.

Changing a few cookie values before confirming the payment lets the student set the **new price to pay themselves** — for example, zero. Free tuition, free anything the union sells.

This is a **business-logic flaw** (improper enforcement of a security-sensitive computed value): the price is a *client-controlled* input instead of an immutable, server-authoritative value.

> Note: as with the IDOR, I limited myself to proof-of-concept — setting the price and confirming the vulnerability — without completing a fraudulent transaction.

## Root cause summary

| Finding | Weakness | Root cause |
|---------|----------|------------|
| Student data by ID | CWE-639 (IDOR) | API trusts the caller-provided ID with no authorization check |
| Price in cookie | CWE-472 (untrusted input) | Server trusts client-supplied payment amount |

Both flaws share the same DNA: **trusting the client**. The client says "give me student 123456's record" and the server obliges; the client says "the price is 0" and the server believes it.

## Fixing it

1. **Authorization on the coupon API** — the request must be authenticated *and* the requested student ID must equal the authenticated user's ID (or fall within a role-based scope).
2. **Never trust client-side state for money** — compute the price server-side, store it server-side, and have the confirmation flow read it from the session/database, not from a cookie.
3. **Signed or encrypted cookies** — if any value *must* live client-side, it needs an HMAC or encryption so tampering is detected.
4. **Least-privilege response shaping** — even for authorized requests, the API should return only the fields the current context actually needs (never the aid reason unless strictly required).

## Disclosure

Reported to Israel's national CERT (INCD):

```
Dear Homi,

We have reported the issue to the university and being taking care of by their staff.
```

## Key takeaways

1. **Every direct object reference needs an authorization check** — the student ID being "hard to guess" is not a control.
2. **Money-related values are server-side by definition** — anything a client can write (cookie, header, POST body) is attacker-controlled.
3. **Sensitive aid data is a blackmail vector** — treat "low-income" markers as highly sensitive, not as an internal convenience field.
