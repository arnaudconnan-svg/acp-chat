from pathlib import Path
import json, hashlib, sys, socket
from urllib.parse import urlsplit, parse_qs
from playwright.sync_api import sync_playwright
# No Python HTTP client or application process; all browser requests are offline mocks.
def denied(*args, **kwargs):
    raise RuntimeError('Synthetic visual smoke: external socket connection denied')
socket.create_connection = denied
socket.socket.connect = denied
root=Path('/workspace/work/m3-visual')
phase=sys.argv[1] if len(sys.argv)>1 else 'initial'
out=root/phase
out.mkdir(exist_ok=True)
fixtures=json.loads((root/'fixtures.json').read_text())['cases']
html=(root/'urgence.html').read_text()
chat=(root/'chat-modal.html').read_text()
results=[]
request_log=[]
with sync_playwright() as pw:
    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,
        args=['--disable-background-networking','--disable-component-update','--disable-default-apps','--no-first-run'])
    for kind, width, height in [('desktop',1440,1000),('mobile',390,844)]:
        for case in fixtures:
            context=browser.new_context(viewport={'width':width,'height':height},
                is_mobile=kind=='mobile',has_touch=kind=='mobile',locale='en-US',
                service_workers='block',offline=True)
            errors=[]
            unexpected=[]
            api_urls=[]
            def route_handler(route):
                url=route.request.url
                parts=urlsplit(url)
                request_log.append({'case':case['id'],'viewport':kind,'url':url})
                if parts.hostname!='synthetic.example.test':
                    unexpected.append(url)
                    route.abort()
                elif parts.path=='/urgence.html':
                    route.fulfill(status=200,content_type='text/html; charset=utf-8',body=html)
                elif parts.path=='/api/emergency-support':
                    api_urls.append(url)
                    route.fulfill(status=200,content_type='application/json',body=json.dumps(case['support']))
                elif parts.path=='/index.html':
                    route.fulfill(status=200,content_type='text/html; charset=utf-8',
                        body=chat.replace('PROFILE',json.dumps({'authenticated':True,'user':{'country':case['country']}})))
                else:
                    unexpected.append(url)
                    route.abort()
            context.route('**/*',route_handler)
            page=context.new_page()
            page.on('pageerror',lambda error: errors.append(str(error)))
            page.goto('https://synthetic.example.test/urgence.html'+case['query'],wait_until='networkidle',timeout=10000)
            page.wait_for_function("document.getElementById('countryLabel').textContent !== 'Chargement...'",timeout=5000)
            page.screenshot(path=str(out/(kind+'-'+case['id']+'.png')),full_page=True)
            metrics=page.evaluate("""() => {
                const ids=['countryLabel','emergencyLine','suicideLine','partialFallback','urgenceBackLink'];
                return {width:innerWidth, scrollWidth:document.documentElement.scrollWidth,
                    horizontalOverflow:document.documentElement.scrollWidth>innerWidth,
                    text:Object.fromEntries(ids.map(id=>[id,{text:document.getElementById(id).textContent,hidden:document.getElementById(id).hidden}])),
                    interpretedImages:document.querySelectorAll('img').length,
                    injected:window.syntheticInjected===true,
                    historyLength:history.length, referrer:document.referrer, fontSize:getComputedStyle(document.getElementById('emergencyLine')).fontSize,
                    lineHeight:getComputedStyle(document.getElementById('emergencyLine')).lineHeight
                };
            }""")
            assert not errors,errors
            assert not unexpected,unexpected
            assert len(api_urls)==1,api_urls
            expected_country=case['country']
            assert parse_qs(urlsplit(api_urls[0]).query).get('country',[None])[0]==expected_country,(case['id'],api_urls)
            label=metrics['text']['countryLabel']['text']
            if case['id']=='unknown_fallback': assert 'ZZ' in label and 'repli' in label and '(FR)' in label
            if case['id']=='absent_explicit': assert 'non précisé' in label and 'repli' in label and '(FR)' in label
            if case['id']=='known': assert '(BE)' in label and 'repli' not in label
            if case['id']=='missing_suicide': assert metrics['text']['suicideLine']['hidden'] and not metrics['text']['partialFallback']['hidden']
            if case['id']=='missing_emergency': assert metrics['text']['emergencyLine']['hidden'] and not metrics['text']['partialFallback']['hidden']
            assert metrics['interpretedImages']==0 and not metrics['injected']
            if case['id']=='html_literal': assert '<img' in metrics['text']['emergencyLine']['text']
            assert 'ressource héritée non validée' in (metrics['text']['emergencyLine']['text']+metrics['text']['suicideLine']['text'])
            page.locator('#urgenceBackLink').click()
            page.wait_for_timeout(200)
            if '/index.html?screen=chatScreen' not in page.url:
                page.screenshot(path=str(out/(kind+'-'+case['id']+'-after-return.png')),full_page=True)
            metrics.update({'case':case['id'],'viewport':kind,'back_direct':page.url,'api':api_urls[0],'errors':errors,'unexpected':unexpected})
            if phase != 'initial':
                assert not metrics['horizontalOverflow'], metrics
                assert page.url == 'https://synthetic.example.test/index.html?screen=chatScreen', (case['id'],page.url)
            results.append(metrics)
            (root/(phase+'-progress.json')).write_text(json.dumps(results,indent=2,ensure_ascii=False))
            context.close()
        # Actual chat modal HTML/CSS and exact click handler; synthetic profile, no app boot.
        for country in ['BE','ZZ',None]:
            case=next(x for x in fixtures if x['id']==({'BE':'known','ZZ':'unknown_fallback',None:'absent_explicit'}[country]))
            context=browser.new_context(viewport={'width':width,'height':height},is_mobile=kind=='mobile',has_touch=kind=='mobile',locale='en-US',service_workers='block',offline=True)
            context.route('**/*',route_handler)
            page=context.new_page()
            page.goto('https://synthetic.example.test/index.html?screen=chatScreen',wait_until='networkidle',timeout=10000)
            page.screenshot(path=str(out/(kind+'-chat-link-'+(country or 'absent')+'.png')),full_page=True)
            page.locator('#humanSupportEmergencyLink').click()
            page.wait_for_url('**/urgence.html?country='+(country or ''),timeout=5000)
            page.wait_for_function("document.getElementById('countryLabel').textContent !== 'Chargement...'",timeout=5000)
            target=page.url
            page.locator('#urgenceBackLink').click()
            page.wait_for_timeout(200)
            if phase != 'initial':
                assert page.url == 'https://synthetic.example.test/index.html?screen=chatScreen', page.url
            results.append({'case':'chat_link','country':country,'viewport':kind,'target':target,'back_history':page.url})
            context.close()
    browser.close()
(root/(phase+'-results.json')).write_text(json.dumps({'phase':phase,'html_sha256':hashlib.sha256(html.encode()).hexdigest(),'results':results,'requests':request_log},indent=2,ensure_ascii=False)+'\n')
for r in results:
    print(json.dumps({k:r[k] for k in ['case','viewport','horizontalOverflow','country','target','back_direct','back_history'] if k in r},ensure_ascii=False))
print('Screenshots='+str(len(list(out.glob('*.png'))))+'; horizontal_overflow_failures='+str(sum(r.get('horizontalOverflow',False) for r in results)))
