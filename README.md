# BMW i4/i5/iX1 Interior Watch

Scrapes BMW Belgium's used-car finder for:

- BMW i4 Gran Coupe, BMW i5 Sedan/Touring, and BMW iX1 SUV (`i4_G26E`, `i5_G60E`, `i5_G61E`, `iX1_U11E`)
- new BMW stock and BMW Premium Selection/occasion stock
- Merino interiors excluding black, plus `Binnenbekleding kunstleder Veganza / M Alcantara combinatie Schwarz`
- mandatory Driving Assistant Pack Professional
- mandatory Parking Assistant Pack Plus
- tow-hitch status

Run:

```sh
npm install
npm run scrape-bmw
```

The scraper automatically prefers an installed system Chrome or Edge binary when one is available, which avoids the Playwright-managed Chromium launch issue on macOS. You can still override it with `CHROME_PATH`, or disable system-browser detection with `DISABLE_SYSTEM_CHROME=1`.

Open the web app:

```sh
npm run web
```

The app prints the local URL, usually `http://127.0.0.1:4173`. If that port is busy, it will try the next port and print the URL it chose.

Run in Docker:

```sh
docker build -t bmw-watch .
docker run --rm -p 4173:4173 bmw-watch
```

Then open `http://localhost:4173`.

The scraper stores the full BMW i4/i5/iX1 inventory in `data/latest.json` under `vehicles`, then the web app filters that data locally. Use `Watchlist defaults` for the strict interior/pack view, or `Show all BMWs` to inspect every scraped car with your own filters for model, inventory type, body, exterior colour, interior, and features. Model, body, exterior colour, and interior choices are populated from the scraped cars, with body/colour/interior narrowing as you choose a model and body.

The ideal match, always shown first, is: i5 Touring, Merino Kupferbraun, tow hitch.

Note: BMW also clusters Veganza Espressobraun as `COGNAC`, but this watcher deliberately excludes Veganza as a cognac/brown match. The exception is M Alcantara seating, which is tracked separately because it is now explicitly included.

Outputs:

- `reports/latest.md`: human-readable report with new/changed/removed listings
- `data/latest.json`: latest normalized match data
- `data/history/YYYY-MM-DD.json`: daily snapshot

The first run creates a baseline. Later runs highlight new matches, removed listings, and changed fields such as price or mileage.
