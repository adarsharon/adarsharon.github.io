# Personal tools

Three small pages that run entirely in the browser, one per folder. The `permalink` line at the top of each HTML file sets its address.

| Address | Folder | What it shows |
|---|---|---|
| [adarsharon.com/arxiv](https://adarsharon.com/arxiv/) | `arxiv/` | The three newest citations of my papers on INSPIRE, and the hep-th papers of the last 30 days by the authors listed in `followed_authors.json`. |
| [adarsharon.com/time](https://adarsharon.com/time/) | `time/` | LA &harr; Israel time converter; the browser's time-zone data handles daylight saving in both countries. |
| [adarsharon.com/surf](https://adarsharon.com/surf/) | `surf/` | Beginner green-wave go/no-go for LA westside beaches, from Open-Meteo, NWS and NOAA tide predictions. The spots are in `beaches.json`; the thresholds are at the top of `surf_check.js`. |

The data comes straight from INSPIRE, Open-Meteo, NWS and NOAA, which all accept requests from browsers. The pages carry a `noindex` tag, so search engines leave them out.

Editing: after changing a `.js` file, raise the `?v=` number where its HTML file loads it, so that browsers fetch the new version. The JSON files are re-read on every visit.

These pages replaced the PythonAnywhere apps `flask_app.py`, `la_israel_time.py` and `surf_checker.py` in November 2026; on test data the JavaScript gives the same output as the Python.
