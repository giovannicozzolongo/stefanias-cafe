/**
 * verify/check.mjs — verifica visiva iterativa del sito vs mockup di Carlo.
 *
 * Uso base (richiede dev server già attivo):
 *   node verify/check.mjs
 *   node verify/check.mjs --full
 *   node verify/check.mjs --url http://localhost:4322/stefanias-cafe/
 *
 * Uso auto (builda e avvia il server da solo):
 *   node verify/check.mjs --auto --full
 *
 * Integrazione Canva (opzionale):
 *   Se in .env ci sono CANVA_API_TOKEN e CANVA_DESIGN_ID, lo script
 *   scarica automaticamente l'ultima versione del design di Carlo prima
 *   di fare il confronto. Nessun export manuale.
 *
 * .env richiesto:
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   CANVA_API_TOKEN=...          # opzionale
 *   CANVA_DESIGN_ID=...          # opzionale, es. DAFxxxxxxx
 */

import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Carica variabili da .env
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const MOCKUP_PATH = path.join(__dirname, 'mockup.png');
const SCREENSHOT_PATH = path.join(__dirname, 'screenshot_current.png');
const REPORT_PATH = path.join(__dirname, 'report.txt');

const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const AUTO_MODE = args.includes('--auto');
const FULL_MODE = args.includes('--full');
let BASE_URL = urlIdx !== -1 ? args[urlIdx + 1] : 'http://localhost:4322/stefanias-cafe/';

// ─── Canva ────────────────────────────────────────────────────────────────────

async function fetchCanvaMockup() {
  const token = process.env.CANVA_API_TOKEN;
  const designId = process.env.CANVA_DESIGN_ID;
  if (!token || !designId) return false;

  console.log(`Scarico design aggiornato da Canva (${designId})...`);

  // 1. Crea job di export
  const createRes = await fetch(`https://api.canva.com/rest/v1/designs/${designId}/exports`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ format: { type: 'png' }, pages: [1] }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    console.warn(`Canva export fallito (${createRes.status}): ${err}`);
    return false;
  }

  const { job } = await createRes.json();
  const jobId = job.id;

  // 2. Polling fino a completamento (max 30s)
  let downloadUrl = null;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await fetch(`https://api.canva.com/rest/v1/exports/${jobId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await pollRes.json();
    if (data.job?.status === 'success') {
      downloadUrl = data.job.urls?.[0] ?? data.job.pages?.[0]?.url;
      break;
    }
    if (data.job?.status === 'failed') {
      console.warn('Canva export fallito.');
      return false;
    }
  }

  if (!downloadUrl) {
    console.warn('Timeout export Canva.');
    return false;
  }

  // 3. Scarica e salva come mockup.png
  const imgRes = await fetch(downloadUrl);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  fs.writeFileSync(MOCKUP_PATH, buf);
  console.log('Mockup aggiornato da Canva.');
  return true;
}

// ─── Server ───────────────────────────────────────────────────────────────────

async function startServer() {
  console.log('Build in corso...');
  execSync('npm run build --silent', { cwd: ROOT, stdio: 'inherit' });
  const port = 4399;
  BASE_URL = `http://localhost:${port}/stefanias-cafe/`;
  const server = spawn('npm', ['run', 'preview', '--', '--port', String(port)], {
    cwd: ROOT, stdio: 'pipe', detached: false,
  });
  await new Promise(r => setTimeout(r, 2500));
  return server;
}

// ─── Screenshot ───────────────────────────────────────────────────────────────

async function takeScreenshot() {
  console.log(`Screenshot di ${BASE_URL} ...`);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 });
  } catch {
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 15000 });
  }
  await page.waitForTimeout(1200);
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
  await browser.close();
  console.log(`Salvato: ${SCREENSHOT_PATH}`);
}

// ─── Confronto AI ─────────────────────────────────────────────────────────────

async function compare(mockupB64, currentB64) {
  const client = new Anthropic();

  const quickPrompt = `Sei un esperto di implementazione front-end. Hai davanti due immagini:
- IMMAGINE 1: il mockup di design originale (riferimento assoluto)
- IMMAGINE 2: lo screenshot attuale dell'implementazione web

Confronta le due immagini sezione per sezione (header, hero, about, reservation, features, story, menu, reviews, info, footer) e per ogni differenza indica:
1. Cosa manca o è sbagliato nell'implementazione
2. Quale valore CSS o struttura HTML va cambiato

Sii specifico: se un colore è sbagliato scrivi il valore hex corretto, se il font è diverso scrivi quale font, se il padding è sbagliato indica la correzione.

Alla fine scrivi esattamente una di queste righe:
ESITO: PASS — se le due immagini sono praticamente identiche
ESITO: FAIL — se ci sono differenze visive significative`;

  const fullPrompt = `Sei un esperto di pixel-perfect front-end development. Hai davanti:
- IMMAGINE 1: il mockup di design originale di Carlo (riferimento assoluto, non si tocca)
- IMMAGINE 2: lo screenshot attuale del sito implementato

Il tuo obiettivo è rendere le due immagini identiche al punto da non riuscire a distinguerle.

Analizza ogni sezione del sito con precisione:

**1. HEADER**
- Logo: dimensioni, posizione, versione (dark/light)
- Nav links: font, dimensioni, colore, spaziatura
- Bottone Reservation: colore esatto, padding, font weight

**2. HERO**
- Immagine di sfondo: quale foto, crop, brightness dell'overlay
- Titolo: font family, dimensione, weight, colore, interlinea
- Sottotitolo: stile, colore
- Bottone CTA: stile, bordo, colore

**3. ABOUT**
- Layout grid: proporzioni colonne
- Heading: dimensione, weight, colore
- Immagine: aspect ratio, object-fit

**4. RESERVATION**
- Calendario: colori, dimensioni celle, stile selected
- Time slots: dimensioni, colori (normale vs selected)
- Bottoni Back/Book Now: stile, colori

**5. FEATURES**
- Intestazione: font, dimensioni
- Card: altezza immagine, posizione testo (sopra/sotto immagine), colori

**6. STORY**
- Immagine bg: overlay opacity
- Titolo e testo: colori, dimensioni

**7. MENU**
- Layout: proporzioni colonne
- Intestazioni sezioni: border-bottom, colore
- Item: font size, weight nome vs prezzo
- Prezzo: colore, allineamento

**8. REVIEWS**
- Background: colore esatto
- Stelle: colore, dimensione

**9. INFO**
- Background: overlay dark o light?
- Lista servizi: font, colore
- Tabella orari: colori, righe evidenziate

**10. FOOTER**
- Background: colore
- Titolo CTA: font, dimensione
- Icone social: dimensione, colore
- Contatti: layout, font

Per ogni differenza trovata scrivi una riga con formato:
[SEZIONE] cosa cambiare → valore corretto

Alla fine:
ESITO: PASS — se le due immagini sono praticamente identiche (differenze < 5%)
ESITO: FAIL — se ci sono differenze significative

In caso di FAIL, elenca i 5 fix più impattanti in ordine di priorità.`;

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: FULL_MODE ? 3000 : 800,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: FULL_MODE ? fullPrompt : quickPrompt },
        { type: 'text', text: '--- IMMAGINE 1: MOCKUP DI CARLO ---' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: mockupB64 } },
        { type: 'text', text: '--- IMMAGINE 2: IMPLEMENTAZIONE ATTUALE ---' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: currentB64 } },
      ],
    }],
  });

  return response.content[0].type === 'text' ? response.content[0].text : '';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY non trovata. Aggiungila a .env');
    process.exit(1);
  }

  // Aggiorna mockup da Canva se configurato, altrimenti usa quello locale
  const canvaUsed = await fetchCanvaMockup();
  if (!canvaUsed && !fs.existsSync(MOCKUP_PATH)) {
    console.error(`Mockup non trovato: ${MOCKUP_PATH}\nConfigura CANVA_API_TOKEN + CANVA_DESIGN_ID in .env oppure metti il file mockup.png manualmente.`);
    process.exit(1);
  }

  let server = null;
  if (AUTO_MODE) server = await startServer();

  try {
    await takeScreenshot();

    const mockupB64 = fs.readFileSync(MOCKUP_PATH).toString('base64');
    const currentB64 = fs.readFileSync(SCREENSHOT_PATH).toString('base64');

    console.log(`\nConfronto mockup vs screenshot${FULL_MODE ? ' (analisi completa)' : ''}...\n`);
    const report = await compare(mockupB64, currentB64);

    console.log('─'.repeat(70));
    console.log(report);
    console.log('─'.repeat(70));

    fs.writeFileSync(REPORT_PATH, `${new Date().toISOString()}\nMODE: ${FULL_MODE ? 'FULL' : 'QUICK'}\n${canvaUsed ? 'MOCKUP: Canva live\n' : ''}\n${report}\n`);
    console.log(`\nReport salvato: ${REPORT_PATH}`);

    process.exit(report.toUpperCase().includes('ESITO: FAIL') ? 1 : 0);
  } finally {
    if (server) server.kill();
  }
}

main().catch(err => {
  console.error('Errore:', err.message);
  process.exit(1);
});
