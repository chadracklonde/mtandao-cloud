# Contrats partagés

Ce dossier contient les schémas versionnés partagés entre API, Flutter et Gateway. Les contrats doivent rester indépendants des détails internes NestJS.

Principes :
- JSON UTF-8; dates ISO-8601 UTC.
- UUID pour les identifiants distribués.
- Chaque événement comporte `schema_version`.
- Toute commande est corrélée par `command_id` et possède une expiration.
- Les erreurs API utilisent un code stable et un message non sensible.

Les premiers exemples sont dans `sync-event.schema.json` et `gateway-command.schema.json`.
