package kommo

// APICommunicationEnabled is intentionally hard-disabled.
//
// Clarin keeps Kommo IDs, CSV import metadata, database schema, and helper
// code, but must not call Kommo's API, register webhooks, poll events, or push
// local changes until this constant is deliberately changed in a future project.
const APICommunicationEnabled = false
