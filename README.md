# Writing Collaborator Actions Backend

A small, stable REST API meant to be used as **GPT Actions** for a Custom GPT writing collaborator.

- No endpoint auth is included (Action auth can be set to **None**).
- No sample payloads or prose are included in this repository.
- The API stores structured writing artifacts (style profiles, character sheets, draft directives, quality reports, revision plans) and performs deterministic prose diagnostics.

## Requirements

- Node.js 20+
- npm
- SQLite (via Prisma)

## Setup

1. Install dependencies
   - `npm install`

2. Create an environment file
   - Copy `.env.example` to `.env`
   - Set `DATABASE_URL` and `PORT` as needed

3. Initialize the database
   - `npm run db:generate`
   - `npm run db:push`

4. Run locally
   - `npm run dev`

The server listens on `http://localhost:<PORT>`.

## GPT Actions

- Host this API on a public HTTPS domain.
- In the Custom GPT builder, add an Action using the `openapi.yaml` in this repo.
- Set the Action authentication to **None** (if you intend to run it without auth).

## Notes

- This backend does not generate prose with another model. The Custom GPT writes prose.
- The backend provides structure, validation, storage, versioning, and diagnostics to keep prose purposeful and consistent.
