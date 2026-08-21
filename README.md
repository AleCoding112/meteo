# Meteo

Un'app meteo fatta su misura, che risponde a due domande invece di mostrare tabelle:
**come mi vesto oggi** e **quando piove**.

È una pagina web installabile sulla schermata Home dell'iPhone, dove si comporta come
un'app vera: si apre a schermo intero, funziona senza rete mostrando l'ultimo dato
scaricato, e non ha nulla da mantenere dietro le quinte.

## Cosa fa

- **Come mi vesto** — un consiglio in chiaro («Felpa e giacca leggera. Ombrello dalle 17»)
  calcolato sulla temperatura *percepita* minima nelle ore in cui sei fuori, da adesso al
  tramonto. Non sulla media del giorno: ci si veste per il momento più freddo.
  Un cursore *freddoloso ↔ caldoso* sposta le soglie sulla tua percezione.
- **Quando piove** — nowcast a passi di 15 minuti sulle prossime 3 ore, con l'ora in cui
  inizia, quando fa una pausa e quando riprende.
- **Che cosa cambia** — avvisi in cima solo quando serve: temporali, gelo notturno, caldo
  forte, raffiche, sbalzi bruschi fra oggi e domani, prima pioggia dopo giorni asciutti.
- **Quanto fidarsi** — tre centri di calcolo indipendenti (ICON, ECMWF, GFS) sullo stesso
  giorno: quanto si discostano fra loro è la misura più onesta di quanto valga la previsione.
- **Che aria tira** — indice europeo, PM2.5/PM10, ozono e i pollini in stagione.
- **Il cielo come interfaccia** — lo sfondo cambia con la condizione e con l'ora: si capisce
  che tempo fa prima ancora di leggere.

I dati vengono da [Open-Meteo](https://open-meteo.com): nessuna chiave, nessun account,
modello ad alta risoluzione scelto automaticamente per la località.

## Pubblicarla

Serve HTTPS: senza, iOS non permette né l'installazione sulla Home né il funzionamento
offline. Con GitHub Pages:

1. crea il repository e carica questi file;
2. **Settings → Pages → Source: Deploy from a branch**, ramo `main`, cartella `/ (root)`;
3. apri l'indirizzo dal telefono, poi **Condividi → Aggiungi alla schermata Home**.

Al primo avvio l'app chiede le località: cercale dalla barra in Impostazioni.
Restano salvate nel telefono.

## Allerte sul telefono

Le notifiche arrivano da un'azione schedulata su GitHub, non dall'app. Il cron non è
puntuale (5-15 minuti di ritardo): va bene per gli avvisi, non per il «piove fra venti
minuti». Configurazione, una volta sola:

1. genera le chiavi: `node tools/make-vapid.js` — la pubblica va in `app.js`
   (`VAPID_PUBLIC`), la privata resta in `vapid-private.txt`, che git ignora;
2. su GitHub, **Settings → Secrets and variables → Actions**, crea il secret
   `VAPID_PRIVATE` con quel valore;
3. apri l'app *installata sulla Home*, Impostazioni → **Attiva le allerte**, concedi il
   permesso e copia il codice che compare;
4. crea un secondo secret chiamato `ALERT_CONFIG` e incollacelo dentro.

Da lì il workflow gira ogni ora nelle ore diurne e scrive solo quando c'è qualcosa di
serio, senza ripetere lo stesso avviso due volte nello stesso giorno.

> GitHub sospende i workflow schedulati nei repository fermi da 60 giorni: basta un commit
> qualsiasi per riattivarli.

## Strumenti

| Comando | Cosa fa |
|---|---|
| `node tools/test-logic.js` | Banco di prova della logica su dati veri e casi costruiti: soglie d'abbigliamento, nowcast, avvisi, fusi orari, cieli |
| `node tools/probe.js [--full]` | Apre l'app in un iPhone virtuale, misura il layout e ne salva la fotografia |
| `node tools/make-icons.js` | Rigenera le icone PNG |
| `node tools/send-alerts.js --dry` | Mostra quali allerte partirebbero, senza inviarle |
| `node tools/make-vapid.js` | Genera le chiavi delle notifiche |

Per provarla in locale: `python3 -m http.server 8765` e apri `http://127.0.0.1:8765`.

## Com'è fatta

Nessuna dipendenza, nessun passo di build: file statici che il browser esegue così come sono.

```
index.html     struttura e libreria di icone SVG
styles.css     dodici cieli, tipografia, layout verticale
app.js         dati, logica dei consigli, rendering
sw.js          funzionamento offline e ricezione delle allerte
fonts/         Manrope (SIL Open Font License)
tools/         prove e utilità, non servono all'app in esecuzione
```

Il cuore è in `app.js`, diviso in sezioni numerate: tabelle e soglie, memoria del
dispositivo, tempo, rete, finestra della giornata, il verdetto, la pioggia immediata,
avvisi e affidabilità, il cielo, rendering, caricamento, impostazioni.

Le soglie stanno tutte in cima al file, con i nomi in chiaro: cambiarle è il modo previsto
per adattare l'app a sé.
