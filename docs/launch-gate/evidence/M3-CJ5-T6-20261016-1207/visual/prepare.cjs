'use strict';
const fs = require('fs');
const { JSDOM } = require('/workspace/acp-chat/node_modules/jsdom');
const { resolveEmergencySupport } = require('/workspace/acp-chat/lib/emergency-resources');
const root = '/workspace/acp-chat';
const destination = '/workspace/work/m3-visual';
const index = fs.readFileSync(root + '/public/index.html', 'utf8');
const doc = new JSDOM(index).window.document;
const modal = doc.getElementById('humanSupportRequestModal').outerHTML;
const styles = [...doc.querySelectorAll('style')].map((x) => x.textContent).join('\n');
const start = index.indexOf('      const humanSupportEmergencyLink =');
const end = index.indexOf('      const humanSupportCancelBtn =', start);
if (start < 0 || end < start) throw new Error('Missing chat link source');
fs.writeFileSync(destination + '/chat-modal.html', '<!doctype html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + styles + '</style></head><body>' + modal + '<script>const userSessionState=PROFILE; const getConversationId=()=>"synthetic_conversation"; window.FacilitatIdentityStorage={session:{setItem(){}}};' + index.slice(start,end) + ';document.getElementById("humanSupportRequestModal").style.display="flex";</script></body></html>');
const registry = {
  FR: { label: 'France — fixture synthétique', emergency: '000', suicide: '001' },
  BE: { label: 'Belgique — fixture synthétique', emergency: '000', suicide: '001' },
  CA: { label: 'Canada — fixture synthétique', emergency: '000', suicide: null },
  CH: { label: 'Suisse — fixture synthétique', emergency: null, suicide: '001' }
};
const malicious = structuredClone(registry);
malicious.BE.emergency = '<img src=x onerror="window.syntheticInjected=true"> TEXTE_SYNTHETIQUE';
const reviewed = structuredClone(registry);
reviewed.BE.services = {
  emergency: {value:'000',status:'reviewed',
    source:{url:'https://source.example.test/services/territory/official-document-with-a-long-unbroken-path-for-local-visual-validation-only', version:'synthetic-v1',retrievedAt:'2026-10-01T00:00:00.000Z',publishedAt:null},
    verifiedAt:'2026-10-01T00:00:00.000Z',
    approval:{candidateDigest:'a'.repeat(64),evidenceUrl:'https://review.example.test/synthetic',reviewedAt:'2026-10-01T00:00:00.000Z',reviewedBy:'SYNTHETIC_REVIEWER'}
  }
};
const cases = [
 {id:'known',query:'?country=BE',country:'BE'},
 {id:'unknown_fallback',query:'?country=ZZ',country:'ZZ'},
 {id:'absent_explicit',query:'?country=',country:null},
 {id:'missing_suicide',query:'?country=CA',country:'CA'},
 {id:'missing_emergency',query:'?country=CH',country:'CH'},
 {id:'html_literal',query:'?country=BE',country:'BE',registry:malicious},
 {id:'reviewed_long_source',query:'?country=BE',country:'BE',registry:reviewed}
].map(({registry: selected, ...item}) => ({...item, support:resolveEmergencySupport(selected || registry,item.country)}));
fs.writeFileSync(destination+'/fixtures.json',JSON.stringify({cases},null,2));
fs.writeFileSync(destination+'/urgence.html',fs.readFileSync(root+'/public/urgence.html'));
console.log('Synthetic fixtures generated with real resolver and source HTML; no server/providers/data loaded.');
