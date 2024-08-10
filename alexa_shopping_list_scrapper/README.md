# Amazon Shopping List Scraper
** This project is based on (https://github.com/jtbnz/amazon_shopping_list/) by https://github.com/jtbnz **

The project scrapes the Amazon Shopping List page and add the items to the Home Assistant Shopping List (todo list) every 3 minutes.
* This is a one-way sync only from Amazon List to Home Assistant and it only adds item to Home Assistant. It does not remove items from Home Assistant (even if removed from Amazon Shopping List)
* This project was crerated using the Amazon USA pages. If you are using amazon in a different location, change the scrapperAmazon.js URLs.

### Important - Do not skip this step<BR>
You will need the Amazon Email and Password that you use to Login, the OTP Secret Key and the Home Assistant Webhook URL.
Please find the instructions on how to get the OTP Secret Key and the Home Assistant Webhook URL:

### How to get your OTP App Secret from Amazon <YOUR_OTP_APP_SECRET>:<BR>
### If you don't have 2-step verification enable:<BR>
1 - Login to Amazon https://www.amazon.com/<BR>
2 - Go to Your Account => Login & Security and click on "Turn On" under 2-step verification<BR>
3 - Select the Authentication App<BR>
4 - Click on "Can't scan the barcode" and save the Key (13 sets of 4 characters each)<BR>
5 - Remove the spaces of the Key (you will have something like this "ASDMASDFMSKDMKSFMKLASDDADABB6JNRNF7WFEHQW23H238R7843")<BR>

### If you already have 2-step verification enable:<BR>
1 - Login to Amazon https://www.amazon.com/<BR>
2 - Go to Your Account => Login & Security and click on "Manage" under 2-step verification<BR>
3 - Under Authenticator App, click on Add New App<BR>
4 - Click on "Can't scan the barcode" and save the Key (13 sets of 4 characters each)<BR>
5 - Remove the spaces of the Key (you will have something like this "ASDMASDFMSKDMKSFMKLASDDADABB6JNRNF7WFEHQW23H238R7843")<BR>

### How to get the Home Assistant Webhook URL:<BR>
1 - Go to your Home Assistant interface and go to Settings, Automations & Scenes, Automations<BR>
2 - Click on "+ Create Automation" and select "Create new automation"<BR>
3 - Click on Add Trigger and select Webhook<BR>
4 - Click on the copy symbol on the right to get the URL and save it (example: http://homeassistant.local:8123/api/webhook/-hA_THs-Yr5dfasnnkjfsdfsa)<BR>
5 - Click on Add Action and select If-Then<BR>
6 - Switch the view to YAML (three dots on the right of the Action block - Edit in YAML)<BR>
7 - Paste the following code:<BR>
```
if:
  - condition: template
    value_template: >-
      {{ trigger.json.name not in state_attr('sensor.shoppinglist_api','list') |
      map(attribute='name') | list }}
then:
  - service: shopping_list.add_item
    data_template:
      name: "{{ trigger.json.name }}"
```
8 - Change the mode from Single to Parallel: <BR>
8.1 - Click on the three dots on the top right of the screen<BR>
8.2 - Click on Change Mode<BR>
8.3 - Select "Parallel" and click on Change Mode<BR>
9 - Click on Save<BR>
10 - The Automation will check if the item is already int he Shopping List and if so, it will not add again<BR>
10.1 - Add the following to your HA configuration.yml<BR>
```
command_line:
- sensor:
    name: shoppinglist_api
    command: >
          echo "{\"list\":" $( cat .shopping_list.json) "}" 
    value_template: > 
        {{ value_json.list | length }}
    json_attributes:
        - list
```
10.2 - Save the file and restart Home Assistant<BR>

Once you have the information above, you can install the AddOn and go to the Configuration Tab.<BR>
In the Configuration add the following informaiton:<BR>

Amazon_Login: <YOUR_AMAZON_EMAIL> \ # your email address used to login at amazon in this format email@email.com<BR><BR>
Amazon_Pass: <YOUR_AMAZON_PASSORD> \ # your password used to login at amazon in this format mypassword1234<BR><BR>
Amazon_Secret: <YOUR_OTP_APP_SECRET> \ # your OTP App Secret in this format myotpsecrete1234 including single quotes. More instructions on <B>How to get your OTP App Secret from Amazon</B><BR><BR>
HA_Webhook_URL: <HOME_ASSISTANT_WEBHOOK_URL> \ # your Home Assistant Webhook URL. More instructions on <b>How to get the Home Assistant Webhook URL:</b><BR><BR>
<BR><BR>
## Extra - Clear Alexa Shopping List
Because this is a one way sync (from Amazon Shopping List to Home Assistant), I have an automation that clear Amazon Shopping list every night at midnight.
Here is the Automation in YAML:

```
description: ""
mode: single
trigger:
  - platform: time
    at: "00:00:00"
condition: []
action:
  - service: media_player.volume_set
    data:
      volume_level: 0.01
    target:
      entity_id: media_player.my_alexa
  - delay:
      hours: 0
      minutes: 0
      seconds: 3
      milliseconds: 0
  - service: media_player.play_media
    data:
      media_content_type: custom
      media_content_id: "clear my shopping list"
      enqueue: play
    target:
      entity_id: media_player.my_alexa
    enabled: true
  - delay:
      hours: 0
      minutes: 0
      seconds: 3
      milliseconds: 0
    enabled: true
  - service: media_player.play_media
    data:
      media_content_type: custom
      media_content_id: "yes"
      enqueue: play
    target:
      entity_id: media_player.my_alexa
    enabled: true



