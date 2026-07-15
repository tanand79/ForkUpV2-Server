# Hostinger database setup

`npm run db:deploy:production` fails on your Windows PC when `DATABASE_URL_PRODUCTION` uses `localhost` — that is **your computer**, not Hostinger.

## Option A — phpMyAdmin (recommended)

1. Log in to **Hostinger hPanel**
2. **Databases** → **Enter phpMyAdmin** (database `u847374826_ForkUp`)
3. Click **Import**
4. Choose file: `api/hostinger-import.sql`
5. Click **Go**

Schema is applied. Demo data: after your API is on Hostinger, SSH in and run `npm run db:seed:production`.

## Option B — Remote MySQL from your PC

1. hPanel → **Databases** → note **MySQL hostname** (e.g. `srv1234.hstgr.io`)
2. hPanel → **Remote MySQL** → add your public IP
3. Edit `api/.env` with remote host + `?ssl=true`

4. Run:

```cmd
cd D:\Harish\Forkup\api
npm run db:deploy:production
```

## Option C — SSH on Hostinger server

SSH into the server, `cd` to the `api` folder, and run `npm run db:deploy:production` there (`localhost` is correct on the server).
