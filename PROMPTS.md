## 1. Analyze the Data and Draft the Schema
(OpenAI ChatGPT Astra)

Analyze the readme.md, messages.json, stations.json
  1. Explain how controllers and stations readings relate.
  2. Create the suggested schema and relations ships.
  3. Translate each requirement into what we need to build.
  4. Inspect the actual data and point out duplicates, conflicts, clock  
  issues, or values we should question. Give specific examples.

## 2. Set up Environment
(Antigravity GEMINI 3.1 PRO)

Create a subagent to set up Docker Compose with PostgreSQL and a Node.js service. Use images existing locally. .en.dev for local development, and .env.example as a template. Also set up .gitignore file and ignore .env in Git. Add a named volume to persist PostgreSQL data, Do not run the containers.

## 3. Initialize the Node.js Server
(Antigravity GEMINI 3.1 PRO)


Initialize the Node.js app in `server/` and connect it to PostgreSQL using credentials from `.env`. Add retry logic for startup failures and lost connections, with a bounded delay between attempts. Print “Successfully connected to database” when the connection is restored and stable. Do not start the containers.

## 4. Add Application Logging
(Antigravity GEMINI 3.1 PRO)


Add structured logging to the Node.js server. Log database connections, retries, errors, and important loader events with useful context and stack traces. Write logs to both the console and rotating log files. Keep credentials and sensitive data out of logs.

# Create sql schema and prisma config
(OpenAI ChatGPT Astra)
Create the SQL schema for the tables proposed above, with proper relationships, keys, constraints, and reasonable normalization.

THIS SCHEMA IS WRONG, YOU MISSED MANY FIELDS LIKE IN STATION TABLE WE HAVE FOUR ATTRIBUTES IN THE STATIONS.JSON FILE, ANALYZE AGAIN AND CREATE THE SCHEMA AGAIN.

(Antigravity GEMINI 3.1 PRO)

Use `db/schema.sql` as the reference to create the Prisma schema and set up Prisma migrations. Keep the tables, relationships, and constraints aligned with the SQL, then create the initial migration.

(Antigravity Claude Sonnet 4.6 (Thinking))


Build the loader in `server/` using the Prisma schema we already made.
Read `stations.json` and `messages.json`. Hash the exact bytes of `messages.json` with SHA-256 and save the hash as `source_hash`. Use it with each delivery’s position so running the loader again does not insert the same data. Keep the original JSON and the order of deliveries and packets.

* Convert the times from registered controllers to UTC.
* If the same sale arrives again, count it once. Use the existing issue codes to flag unknown controllers, conflicting sales, invalid packets, and amounts that do not match the volume and price. Keep the reported values as they are.
* Load the file in one database transaction.
* Run the loader when the server starts, after connecting to the database.
* Organize the folders and put reusable functions in `utils/`.
* Leave the daily sales report for later.

(Antigravity Claude Sonnet 4.6 (Thinking))

Review the loader and check whether it handles these cases:
* Invalid fields, dates, numbers, and packet types
* Bad packets versus a file that cannot be parsed
* Exact sale replays versus conflicting sales
* Duplicate tank readings
* A clear tolerance for amount mismatches
* Unknown controllers and their timestamps
* Unchanged row counts after two runs, plus the known examples in the data

For each item, tell me what the code currently does and what is missing. Do not change any code yet.
