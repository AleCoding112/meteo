# Meteo

Un'app meteo che risponde a due domande invece di mostrare tabelle:
**come mi vesto oggi** e **quando piove**.

È una pagina web autonoma (PWA): si installa sulla schermata home
dell'iPhone come una vera app, si apre a tutto schermo e funziona
anche senza rete, mostrando l'ultima previsione scaricata e
dichiarando quanto è vecchia.

## Come funziona

**Il verdetto sull'abbigliamento** non guarda la temperatura media
del giorno ma il *minimo percepito nelle ore in cui sei fuori*, dalla
adesso al tramonto — perché ci si veste per il momento più freddo,
non per la media. Dopo il tramonto la finestra scivola all'alba del
giorno dopo. Alla scala di base si aggiungono i modificatori:
ombrello se la probabilità supera il 40% o si accumula mezzo
millimetro, "cipolla" se l'escursione supera i 9°, cappuccio al posto
dell'ombrello sopra i 45 km/h di raffica.

**La taratura personale** è il cursore *freddoloso ↔ caldoso* nelle
impostazioni: sposta le soglie di 1,5° per tacca. Se l'app ti mette
la giacca e tu sudi, spostalo verso "caldoso" e smette di farlo.
È la parte che la rende tua e che nessuna app del negozio ti dà.

**La pioggia nell'immediato** usa le previsioni a 15 minuti del
modello ad alta risoluzione disponibile sulla località. Attenzione a
cosa può e non può fare: risponde bene a *"nella prossima ora
piove?"*, **non è un radar** e non è affidabile sul minuto esatto.
Quando il modello non prevede acqua ma la probabilità oraria resta
alta (rovesci sparsi) l'app lo dichiara invece di promettere sereno.

## I dati

[Open-Meteo](https://open-meteo.com): niente chiave, niente account,
niente registrazione. Una sola chiamata per località restituisce
condizione attuale, quarti d'ora, ore e sette giorni. La ricerca
delle città usa il loro geocoding. Le località scelte e le previsioni
restano sul dispositivo (`localStorage`): nessun server intermedio,
nessun account, nessun dato che esce dal telefono.

## Pubblicarla su GitHub Pages

Serve HTTPS: senza, iOS non permette né l'installazione sulla home né
il funzionamento offline. Aprire il file dal Finder non basta.

```bash
# 1. crea un repository vuoto su github.com (senza README)
# 2. dalla cartella del progetto:
git remote add origin https://github.com/TUO-UTENTE/meteo.git
git push -u origin main
# 3. su GitHub: Settings → Pages → Source: "Deploy from a branch"
#    → Branch: main / (root) → Save
```

Dopo un paio di minuti l'app è su
`https://TUO-UTENTE.github.io/meteo/`.

Per aggiornarla in seguito: `git add -A && git commit -m "..." && git push`.

## Installarla sull'iPhone

Apri l'indirizzo **in Safari** (non Chrome), tocca il pulsante di
condivisione e scegli *Aggiungi a Home*. Da quel momento l'icona apre
l'app a tutto schermo. Al primo avvio aggiungi le tue località dalla
rotella in alto a destra.

## Provarla sul Mac

```bash
python3 -m http.server 8765
# poi apri http://127.0.0.1:8765
```

## Verifiche

```bash
node tools/test-logic.js
```

Esercita la logica su dati veri di sei città in fusi e stagioni
diverse (compreso l'emisfero sud e il sole di mezzanotte islandese) e
su casi costruiti a mano: ogni fascia della scala d'abbigliamento,
l'effetto del cursore, pioggia in arrivo / in corso / assente, e il
passaggio a "domani" dopo il tramonto.

## Struttura

| File | Cosa contiene |
|---|---|
| `index.html` | struttura della pagina e libreria di icone SVG |
| `styles.css` | temi chiaro e scuro, entrambi ad alto contrasto |
| `app.js` | dati, logica del verdetto, nowcast, rendering |
| `sw.js` | funzionamento offline (rete per prima, cache di scorta) |
| `manifest.webmanifest` | nome, icone e modalità a tutto schermo |
| `tools/make-icons.js` | rigenera le icone PNG senza dipendenze |
| `tools/test-logic.js` | banco di prova della logica |

## Personalizzare

Le manopole stanno tutte in cima ad `app.js`, nella sezione
*Tabelle e soglie*:

- `LAYERS` — la scala d'abbigliamento: cambia le frasi con le tue
  parole o sposta le soglie in gradi.
- `POP_UMBRELLA`, `MM_UMBRELLA` — quando scatta l'ombrello.
- `GUST_WINDY` — la raffica oltre cui l'ombrello è controproducente.
- `SWING_LAYERED` — l'escursione che fa scattare il consiglio "a cipolla".
- `CHILL_STEP` — quanto pesa ogni tacca del cursore.

Dopo aver modificato i file, ricaricando la pagina vedi subito il
risultato: il service worker prova sempre la rete per prima.
