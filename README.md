# Competitor Briefing Daily

A Lambda that has Claude research competitor news each morning and saves a dated Google Doc to the `competitor` folder of the `ai-briefings` shared drive.

- `index.js`: Claude API call (web search + fetch), then the Drive upload
- `prompt.md`: what the brief covers; edit this to change it

## Run locally

`ANTHROPIC_API_KEY`, `GOOGLE_SA_JSON` and `GDRIVE_FOLDER_ID` are read from Parameter Store under `/competitor-briefing/`. Any of them set in the environment or `.env` wins.

```sh
npm install
npm test          # offline checks
npm run brief     # real run, prints the brief, no upload (about $1)
npm run upload    # real run + Google Doc
```

## Deploy

Lambda `competitor-briefing-daily` in `us-east-1`, triggered by EventBridge Scheduler `competitor-briefing-daily-8am-et` at 8:00 AM Eastern. Alarms go to incident.io.

```sh
zip -r function.zip index.js prompt.md node_modules package.json
aws lambda update-function-code --function-name competitor-briefing-daily --zip-file fileb://function.zip
```

The service account must be a Contributor on the shared drive.
