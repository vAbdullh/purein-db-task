## 1. Analyze the Data and Draft the Schema

Analyze the readme.md, messages.json, stations.json
  1. Explain how controllers and stations readings relate.
  2. Create the suggested schema and relations ships.
  3. Translate each requirement into what we need to build.
  4. Inspect the actual data and point out duplicates, conflicts, clock  
  issues, or values we should question. Give specific examples.

## 2. Set up Environment

Create a subagent to set up Docker Compose with PostgreSQL and a Node.js service. Use images existing locally. .en.dev for local development, and .env.example as a template. Also set up .gitignore file and ignore .env in Git. Add a named volume to persist PostgreSQL data, Do not run the containers.

## 3. Initialize the Node.js Server

Initialize the Node.js app in `server/` and connect it to PostgreSQL using credentials from `.env`. Add retry logic for startup failures and lost connections, with a bounded delay between attempts. Print “Successfully connected to database” when the connection is restored and stable. Do not start the containers.

## 4. Add Application Logging

Add structured logging to the Node.js server. Log database connections, retries, errors, and important loader events with useful context and stack traces. Write logs to both the console and rotating log files. Keep credentials and sensitive data out of logs.

