# NL Browser

An advanced research browser and companion tool for [Nexus Legacy](https://nexuslegacy.space).

## Features

- **Research Browser** — search and filter your full research tree by branch (Military, Economy, Science) and status (In Progress, Available, Completed, Locked, Maxed)
- **Multiple sort methods** — Era, Level, Cost, Time, Branch, Category, and more, all bidirectional
- **View modes** — card, column (grouped by branch), and table
- **Research Planner** — queue upgrades and see total resource costs (ore, silicates, hydrogen, alloys) and research time across your plan
- **Data Export** — download your full API snapshot as JSON; combine with any LLM and a game guide for real-time feedback
- **Feature request box** — suggest improvements directly from the app

## How It Works

NL Browser is a web app that authenticates via your existing Nexus Legacy session. Your session token is stored server-side only and never sent to the client.

## Usage

**Via Chrome Extension (recommended)**

1. Install the [Chrome Extension](https://chromewebstore.google.com/detail/nl-browser/eljpfjmfmbeeddcbjjfhhoeigdjfnlog)
2. Log in to [Nexus Legacy](https://www.nexuslegacy.space/lobby) in your browser
3. Click the extension icon → **Open Dashboard**

**Without the extension**

1. Go to [nlbrowser-production.up.railway.app](https://nlbrowser-production.up.railway.app)
2. Log in to [Nexus Legacy](https://www.nexuslegacy.space/lobby) in your browser
3. Press `F12` → **Application** → **Cookies** → copy the value of `nexus_token`
4. Click **manual login** on the NL Browser login screen and paste your token

## License

MIT — see [LICENSE](LICENSE)
