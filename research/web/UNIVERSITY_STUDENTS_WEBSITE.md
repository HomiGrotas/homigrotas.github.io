# The research goal
Well, my first research wasn't intended at all.<br>
I just needed to pay in the student's union website, and saw something weird.

**This research isn't docemented fully since I didn't verify yet with the university satff they closed the vulnerability**

## The research
### IDOR
When the website searches for coupon validation, it sends the student id to an API that returns the full information about the student (and  the reason for the coupon, which might be an economic issue), which may give enough information for blackmailing low-economic students, alongside phishing attacks.


Data extracted:

    * city
    * country
    * street address
    * birthdate
    * first name
    * last name
    * email
    * phone number
    * zip code
    * reminder date
    * reason why they got the coupon


### Cookie tampering
Dude, what?<br>

Changing some cookie values after the website makes a lookup request for a discount, leading to an option to set the new price the student should pay, which will probably be 0- FREE.



## INCD response
```
Dear Homi,

 

We have reported the issue to the university and being taking care of by their staff. 
```
