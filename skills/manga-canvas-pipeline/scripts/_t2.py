import requests
base='http://127.0.0.1:3000/v1'
key='sk-a92ac692e8cfe46ef36ea0f12372138d3c4468b0ee6423a094aba2cc1cdda599'
cases = [
  {'name':'plain','body':{'model':'hy3','messages':[{'role':'user','content':'hi'}]}}
  ,{'name':'max_tokens','body':{'model':'hy3','messages':[{'role':'user','content':'hi'}],'max_tokens':1,'stream':False}}
  ,{'name':'stream','body':{'model':'hy3','messages':[{'role':'user','content':'hi'}],'stream':True}}
]
for c in cases:
    r = requests.post(base+'/chat/completions', headers={'Content-Type':'application/json','Authorization':'Bearer '+key}, json=c['body'], timeout=60)
    print(c['name'], r.status_code, r.text[:150])
