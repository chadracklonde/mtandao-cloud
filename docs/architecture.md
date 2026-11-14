# Architecture Mtandao Cloud

## Vue d'ensemble

Le système comporte trois clients : Mtandao Ticket (Flutter), le tableau de bord Web (Next.js) et Mtandao Gateway (Linux/Android). Ils communiquent avec l'API NestJS en HTTPS. La passerelle établit une connexion sortante sécurisée vers le Cloud et dialogue localement avec RouterOS.

## Responsabilités

- **NestJS** : autorisation métier, validation, orchestration, API publique, webhooks, synchronisation et commandes passerelle.
- **Supabase Auth** : identité et sessions.
- **PostgreSQL** : données multi-sites, contraintes, audit et RLS.
- **Next.js** : interface Web. Aucun secret privilégié ne doit y être exposé.
- **Gateway** : exécution locale d'opérations RouterOS explicitement autorisées.
- **Flutter** : gestion locale et file d'attente hors connexion.

## Isolation multi-site

Chaque établissement est un tenant indépendant identifié par `site_id`. Les utilisateurs obtiennent un accès par `site_memberships`. Une identité peut être membre de plusieurs sites avec des rôles différents. Toute requête métier doit vérifier l'appartenance au site côté serveur; RLS constitue une défense supplémentaire.

## Autorité des données

- Paiement : confirmation vérifiée du fournisseur côté serveur.
- Session et état effectif du Hotspot : MikroTik.
- Membres et permissions Cloud : Cloud.
- Événements hors ligne : source locale jusqu'à réception et validation serveur.

Ne jamais écraser une donnée autoritaire par un événement plus ancien simplement parce qu'il arrive plus tard.

## Synchronisation

Chaque événement possède un UUID stable, un site, un appareil source, un type, une version de schéma, une date d'occurrence et un payload. Le serveur déduplique par identifiant et accuse réception après validation. Les clients conservent les événements non acquittés dans une outbox persistante.

## Paiements

Un paiement et un ticket sont deux objets distincts. Une transaction n'est réussie qu'après confirmation authentifiée du prestataire. Les webhooks sont vérifiés, dédupliqués et journalisés. Une commande de création de voucher est envoyée à la passerelle après confirmation; sa réussite est confirmée séparément par le routeur.

## Sécurité

- TLS en transit; secrets chiffrés au repos.
- Aucun mot de passe RouterOS, secret fournisseur ou clé service-role dans Flutter ou le navigateur.
- Commandes passerelle signées, limitées, expirables et anti-rejeu.
- RLS sur les tables exposées; tests d'accès inter-tenant.
- Journal d'audit pour les actions sensibles.
- Ne pas exposer l'API RouterOS directement sur Internet.

## Monnaies

Les montants sont des entiers en unités mineures définies par devise, jamais des flottants. Chaque forfait et transaction conserve sa devise (CDF ou USD). Les conversions utilisent un taux daté et conservé; ne jamais additionner des montants de devises différentes sans conversion explicite.

## Déploiement

Environnements séparés : development, staging, production. Les migrations sont versionnées et exécutées dans un pipeline contrôlé. Les webhooks et paiements réels restent désactivés jusqu'à validation des comptes marchands et tests sandbox.
