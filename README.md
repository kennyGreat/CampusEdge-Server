# CampusEdge Server (GitHub-ready)

This is a GitHub-ready Node/Express server for CampusEdge.
- Includes placeholder configs for Supabase, Termii, and Google Sheets in .env.example
- Uses local fallback storage if you don't configure external services
- Endpoints:
  - POST /payment  { studentId, amount, agent, source, phone }
  - POST /agent/approve  { paymentId, agent }
  - POST /admin/approve  { paymentId, adminNote, notifyPhone }  (requires ADMIN_SECRET header/query)
## Run locally
1. copy .env.example to .env and fill keys
2. npm install
3. npm start
