# Gentree Villas HOA Management System

This is a local HOA management system for **Gentree Villas Homeowners Association Inc.** It manages members, block and lot records, monthly dues, donations, court and clubhouse rentals, membership and certificate payments, total fund, expenses, payroll, and printable Statements of Account.

The app stores data in the browser for offline/local use and can sync the same data to Google Sheets when internet is available. The Google Sheet uses separate tabs with readable rows for members, dues, payments, donations, rentals, memberships, certificates, expenses, payroll, activity, and settings.

## Start the App

### Easiest Way

Double-click:

```text
Open HOA System.cmd
```

This starts the local system and opens it in a maximized app window without the normal browser address bar.

Do not open `index.html` directly if you want the system-style window. Browsers do not allow an HTML file to hide the address bar by itself.

### Windows PowerShell

1. Open this folder in PowerShell.
2. Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-HOA.ps1
```

3. The system opens automatically in a maximized browser app window without the normal address bar:

```text
http://localhost:4173
```

To start the local server without opening the browser automatically, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-HOA.ps1 -NoBrowser
```

### Node.js Alternative

If Node.js 18 or newer is installed, run:

```powershell
npm start
```

Then open:

```text
http://localhost:4173
```

## Google Sheets Setup

1. Use this Google Sheet as the database:

```text
https://docs.google.com/spreadsheets/d/1zEi0twiEq6s14YS-tMj3S2PXAfb6CI24lX4dP3AePNI/edit?usp=sharing
```

2. In the sheet, open **Extensions > Apps Script**.
3. Delete any starter code.
4. Copy the contents of `google-apps-script/Code.gs` into Apps Script. The script is already configured to use spreadsheet ID `1zEi0twiEq6s14YS-tMj3S2PXAfb6CI24lX4dP3AePNI`.
5. Click **Deploy > New deployment**.
6. Select **Web app**.
7. Set **Execute as** to `Me`.
8. Set **Who has access** to the officers who will use the system, or `Anyone with the link` if your Google Workspace allows it.
9. Deploy and copy the Web App URL.
10. The app is currently configured to use this Web App URL by default:

```text
https://script.google.com/macros/s/AKfycbz6mEGMr1OlJc-k8Vus30c2JayWxSdiGTdBTyXE4HxjT-m3hc3iN_5ijKoijp9ZkV8D/exec
```

11. If the deployment URL changes later, open **Settings**, paste the new Web App URL, and click **Save Settings**.
12. Sign in once to load the Google Sheet data. Future edits save locally until **Save** or **Logout** is clicked.

For a new officer or a new computer, paste the same Web App URL in **Settings**, save it, then click **Load** before adding or editing records.

The app now includes the default Web App URL, so a new device should automatically load the Google Sheet data during login. Use **Load** manually only if you need to refresh the local copy while already signed in.

## Gmail SOA Email

The **SOA Print > Send Email** button opens Gmail in a new browser tab with the selected member's saved email address, subject, and SOA details already filled in.

Gmail does not allow local web apps to automatically attach a file through a compose link. If a PDF attachment is required, first use **Download PDF**, save the SOA, then attach that saved file in the Gmail draft.

## Daily Use

- Sign in with the default admin account on first use: `admin` / `admin123`.
- Open **Users** to add officer/staff accounts, change passwords, deactivate old users, and control who can manage system users.
- Add members in **Members**.
- Use **Members > Import CSV** for bulk member import. Required columns are `name`, `block`, and `lot`; optional columns are `contact`, `email`, `notes`, and `status`.
- Generate monthly bills in **Monthly Dues**.
- Record payments from the dues table.
- Add operating expenses in **Expenses**.
- Add staff or service payroll in **Payroll**.
- Print, download, or email a member Statement of Account in **SOA Print**.
- Review cash position and balances in **Dashboard**.
- Click **Load** only when intentionally restoring or refreshing the Google Sheet copy over the local copy.
- Searches use the fast local copy. Edits stay local until **Save** is clicked.

## Handover Notes for Future Officers

- Keep the Google Sheet and Apps Script deployment owned by an official HOA Google account.
- Do not delete the Apps Script project or the Web App deployment.
- Give the next officers the Google Sheet access and this local app folder.
- Records in the Google Sheet are table-based, so they can be reviewed or backed up without opening the app.
- Before turnover, create admin accounts for the next officers and deactivate accounts that should no longer access the system.
- The **Beginning fund balance** in Settings should be set once when starting the system. After that, the fund is computed as:

```text
Beginning fund balance + dues payments + donations + rentals + membership payments + certificate payments - all expenses - all payroll
```

- Use **Logout** before closing the app when possible. Logout saves all local records to Google Sheets before signing out.

## Data Safety

The local browser keeps a fast working copy using local storage. Google Sheets keeps the shared permanent copy. Changes are saved locally immediately and are sent to Google Sheets only when **Save** is clicked or when the user logs out. For long-term records, periodically download a backup copy of the Google Sheet.
