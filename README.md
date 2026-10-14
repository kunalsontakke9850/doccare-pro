# DocCare Pro

DocCare Pro is a browser app for scan entry, fee tracking, expenses, doctor summaries, and printable bills. The interface uses plain HTML, CSS, and JavaScript. The original installation stores shared records in Google Sheets through an Apps Script web app.

## Demo

The GitHub Pages build runs with sample records and saves edits in the current browser. It does not send records to a server. Use names beginning with `Sample` or `Demo` when adding a row. Clear this site's browser storage to restore the starter data.

Admin access is disabled in the public demo. The demo is for trying the interface; it is not connected to a clinic and is not intended for clinical use.

## Run it locally

Install Node.js, then run:

```sh
npm install
npm run build:demo
npm run start:demo
```

Open the local address printed by the server. The same demo can be built with `npm run build:demo`; generated files go into `demo-dist/`.

## Use a backend of your own

Copy `config.js.example` to `config.js`, then set `SCRIPT_URL` to your own Apps Script web app and replace the sample clinic settings. Keep `config.js` private. `npm start` serves the production-configured local app; `npm run start:test` runs against the local test service. Do not point the public demo at a clinic endpoint.

The Apps Script deployment source and its setup notes are not included in this repository. The public source contains the browser app, its demo adapter, and the local test suite.

## Checks

```sh
npm test
npm run test:demo
npm run build:demo
npm run check:release
```

The test runner omits deployment-source checks when the private Apps Script file is not present.

## GitHub Pages

Pushing to `main` runs the Pages workflow. It runs the tests, builds the allowlisted demo files, and publishes only `demo-dist/`. The workflow does not need clinic credentials or production configuration.
