# Event Arrivals

Check people in at the door and show an airport-style arrivals board on the projector.

- **Check-in desk** (`/checkin`): search a name, tap **Arrived**, **Delayed** or **Cancelled**. Needs a login.
- **Arrivals board** (`/board`): the projector screen. Updates by itself within about two seconds, flips like an airport board and announces each arrival. Press `F` for full screen, `D` for display settings (how many people per screen, columns, speed, name order).
- **Logins**: the first person to open the site creates the first login. Add more from the desk under Settings, Manage logins.

The guest list starts from `lib/seed.js` and can be edited from the desk (Add people, or the `...` button on a row).

## Run it on one laptop (no internet, no database)

1. Install [Node.js](https://nodejs.org) (version 20 or newer).
2. Double-click **Run locally.bat** (or run `npm start`).
3. The window shows the addresses. Other laptops and phones on the **same Wi-Fi** open the "Same Wi-Fi" address, for example `http://192.168.1.20:3000/checkin` for the desk and `/board` for the projector.

Keep that window open during the event. Everything is saved in `.local-data/state.json` on that laptop. If Windows asks whether to allow Node.js through the firewall, choose Allow, otherwise the other laptop cannot connect.

## Put it on Vercel (works from anywhere)

Vercel cannot keep data by itself, so the site needs a small free database. Without it the pages show "connect storage".

1. Push this folder to GitHub and import the repository at [vercel.com/new](https://vercel.com/new). Keep every build setting as it is and press Deploy.
2. In the Vercel project open **Storage**, choose **Upstash**, create a **Redis** database (free plan, region Mumbai) and connect it to the project.
3. Open **Deployments**, choose the latest one and press **Redeploy**.
4. Open the site straight away and create the first login, then add the others from the desk.

The database on Vercel is separate from the one on your laptop, so logins and check-ins made locally do not appear there.

## How it is built

| Path | What it is |
| --- | --- |
| `public/` | The pages: home, login, check-in desk, board. Plain HTML, CSS and JavaScript. |
| `api/index.js` | The single Vercel Function. |
| `lib/app.js` | All server logic: state, logins, actions. |
| `lib/store.js` | Storage: Upstash Redis on Vercel, a JSON file locally. |
| `lib/seed.js` | The starting guest list. |
| `dev/local-server.js` | Runs the same pages and API on your own computer. |

Screens stay in sync by asking the server every two seconds whether anything changed, so close the board tab after the event to avoid using up the free database quota.
