#!/usr/bin/env node
/**
 * verify-models.js — sanity check for the pricing data.
 *
 * The prices live inside index.html, in:
 *     <script id="pricing-data" type="application/json"> … </script>
 * That block is the single source of truth. This script reads it from there.
 *
 *   node verify-models.js                  # validate index.html
 *   node verify-models.js candidate.json   # validate + diff a candidate against it
 *   node verify-models.js --export         # write the block out to models.json
 *
 * A price update must never land silently: this fails loudly on a broken or
 * partial block, an implausible number, or a stale "checked" date.
 * Exit code 1 = do not ship.
 */
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, 'index.html');
const MAX_AGE_DAYS = 45;
const REQUIRED = ['id','provider','label','input_per_mtok','output_per_mtok','source_url','checked'];

let fail = 0, warn = 0;
const bad = m => { console.error('FAIL: ' + m); fail++; };
const soft = m => { console.warn('WARN: ' + m); warn++; };

/** Pull the pricing block out of index.html. */
function loadFromHtml(){
  let html;
  try { html = fs.readFileSync(HTML, 'utf8'); }
  catch(e){ bad('cannot read index.html — ' + e.message); process.exit(1); }

  const m = html.match(/<script[^>]*id=["']pricing-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if(!m){
    bad('no <script id="pricing-data"> block in index.html — the page has no prices at all');
    process.exit(1);
  }
  try { return JSON.parse(m[1]); }
  catch(e){ bad('the pricing-data block is not valid JSON — ' + e.message); process.exit(1); }
}

function loadJson(p){
  try { return JSON.parse(fs.readFileSync(p,'utf8')); }
  catch(e){ bad('cannot parse ' + p + ' — ' + e.message); process.exit(1); }
}

function validate(data, name){
  if(!Array.isArray(data.models) || data.models.length === 0)
    return bad(name + ': no models array — this is what a broken paste looks like');
  if(data.models.length < 10)
    bad(name + ': only ' + data.models.length + ' models, expected 12 — partial paste?');

  const ids = new Set();
  for(const m of data.models){
    const tag = name + '/' + (m.id || '?');
    for(const k of REQUIRED) if(m[k] === undefined || m[k] === null || m[k] === '')
      bad(tag + ': missing ' + k);
    if(ids.has(m.id)) bad(tag + ': duplicate id');
    ids.add(m.id);

    const i = m.input_per_mtok, o = m.output_per_mtok, c = m.cached_input_per_mtok;
    // Plausibility: no provider charges 0, and nothing is $500/Mtok.
    if(!(i > 0 && i < 200)) bad(tag + ': input ' + i + ' outside plausible range 0–200');
    if(!(o > 0 && o < 500)) bad(tag + ': output ' + o + ' outside plausible range 0–500');
    if(o < i) soft(tag + ': output cheaper than input — unusual, check it');
    if(c != null && !(c >= 0 && c <= i)) bad(tag + ': cached input ' + c + ' must be ≤ base input ' + i);
    if(m.cache_write_per_mtok != null && m.cache_write_per_mtok < i)
      soft(tag + ': cache write cheaper than base input — unusual');
    if(!/^https:\/\//.test(m.source_url)) bad(tag + ': source_url is not https');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(m.checked)) bad(tag + ': checked is not YYYY-MM-DD');

    const age = (Date.now() - Date.parse(m.checked)) / 864e5;
    if(age > MAX_AGE_DAYS) soft(tag + ': price is ' + Math.round(age) + ' days old');
    if(age < -1) bad(tag + ': checked date is in the future');
    if(m.promo_until && Date.parse(m.promo_until) < Date.now())
      bad(tag + ': promo price expired on ' + m.promo_until + ' — price has changed');
  }

  const provs = new Set(data.models.map(m => m.provider));
  for(const p of ['OpenAI','Anthropic','Google'])
    if(!provs.has(p)) bad(name + ': no models from ' + p);

  if(data.fx && data.fx.checked){
    const fxAge = (Date.now() - Date.parse(data.fx.checked)) / 864e5;
    if(fxAge > MAX_AGE_DAYS) soft(name + ': exchange rates are ' + Math.round(fxAge) + ' days old');
  }
}

const arg = process.argv[2];
const base = loadFromHtml();

if(arg === '--export'){
  fs.writeFileSync(path.join(__dirname,'models.json'), JSON.stringify(base, null, 2) + '\n');
  console.log('wrote models.json from the block in index.html');
}

validate(base, 'index.html');

if(arg && arg !== '--export'){
  const cand = loadJson(path.resolve(arg));
  validate(cand, 'candidate');
  console.log('\n--- diff vs index.html ---');
  const byId = Object.fromEntries(base.models.map(m => [m.id, m]));
  let changes = 0;
  for(const m of cand.models){
    const b = byId[m.id];
    if(!b){ console.log('NEW    ' + m.id); changes++; continue; }
    for(const k of ['input_per_mtok','cached_input_per_mtok','cache_write_per_mtok','output_per_mtok']){
      if(b[k] !== m[k]){
        const pct = b[k] ? ((m[k] - b[k]) / b[k] * 100).toFixed(0) + '%' : 'n/a';
        console.log('CHANGE ' + m.id + ' ' + k + ': ' + b[k] + ' → ' + m[k] + '  (' + pct + ')');
        changes++;
        if(b[k] && Math.abs((m[k] - b[k]) / b[k]) > 0.6)
          soft(m.id + '/' + k + ': >60% swing — verify by hand before shipping');
      }
    }
    delete byId[m.id];
  }
  for(const id of Object.keys(byId)){ console.log('GONE   ' + id); changes++; }
  if(!changes) console.log('no price changes');
}

console.log('\n' + (fail ? fail + ' FAIL' : 'OK') + (warn ? ', ' + warn + ' warning(s)' : ''));
process.exit(fail ? 1 : 0);
