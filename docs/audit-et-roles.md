# Audit et rôles — Lot 2

## Journal d'audit

Table `audit_log`, en ajout seul. Les entrées sont écrites par des déclencheurs PostgreSQL sur les tables concernées : aucun chemin de code (API, RPC, SQL direct) ne peut les contourner.

| Action | Déclenchée par |
| --- | --- |
| `site.created` | création d'un site |
| `member.added`, `member.updated` | ajout d'un membre, changement de rôle ou de statut |
| `invitation.created`, `invitation.accepted`, `invitation.expired`… | cycle de vie d'une invitation |
| `router.registered` | enregistrement d'un routeur |
| `gateway.revoked`, `gateway.reenrollment_started` | révocation et ré-enrôlement du Gateway |
| `router.status_changed` | suspension ou fin de suspension |

Les bascules `online`/`offline` du heartbeat ne sont pas journalisées, pour ne pas noyer le journal.

Chaque entrée contient : `site_id`, `actor_user_id` (`auth.uid()`, nul pour une opération système ou un Gateway), `action`, `entity_type`, `entity_id`, `details` (JSON), `occurred_at`. Le payload ne contient jamais de secret : les jetons d'enrôlement ne sont pas journalisés.

## Garanties

- Lecture réservée aux rôles `owner` et `admin` du site (RLS, helper `private.has_site_role`).
- Aucune écriture par les clients ; `UPDATE`, `DELETE` et `TRUNCATE` sont refusés à tous, y compris au propriétaire de la table (déclencheur).
- Les entrées d'un site ne sont pas supprimées avec le site : `site_id` n'a pas de clé étrangère.

## API

`GET /v1/sites/:siteId/audit?limit=50&before=<id>`

- Authentification Bearer ; l'autorisation est appliquée par la base avec le jeton de l'utilisateur.
- Du plus récent au plus ancien. `limit` : 1 à 200 (50 par défaut). `before` : identifiant de la dernière entrée reçue (pagination par curseur).
- Un utilisateur sans droit reçoit une liste vide.

## Matrice des rôles vérifiée par les tests

| Opération | owner | admin | manager | seller | technician | viewer |
| --- | --- | --- | --- | --- | --- | --- |
| Inviter (hors admin) | oui | oui | non | non | non | non |
| Inviter un admin | oui | non | non | non | non | non |
| Enregistrer un routeur | oui | oui | non | non | oui | non |
| Révoquer / ré-enrôler un Gateway | oui | oui | non | non | non | non |
| Lire le journal d'audit | oui | oui | non | non | non | non |

Tests : `supabase/tests/roles_audit.test.sql` (via `supabase/tests/run.sh`) et `apps/api/src/audit/audit.service.spec.ts`.
