# Mtandao Cloud — Cahier des charges technique et fonctionnel

- Version : 0.1
- Date de référence : 13 novembre 2026
- Dépôt : chadracklonde/mtandao-cloud
- Statut : document de cadrage de référence, à faire évoluer avec les décisions validées
- Source : document de cadrage Word Mtandao Cloud v0.1 et décisions techniques consignées dans ce dépôt

## 1. Objet et vision

Mtandao Cloud est la plateforme centrale facultative qui relie Mtandao Ticket, les sites Wi-Fi, les routeurs MikroTik, les clients, les vendeurs et les prestataires de paiement. Elle apporte la gestion multi-sites, la synchronisation, le suivi financier consolidé, les opérations distantes autorisées, le portail client et l'analyse des données.

Le système reste hybride : Mtandao Ticket doit continuer à assurer les opérations locales essentielles lorsque l'accès Internet ou le Cloud est indisponible. Le Cloud orchestre et conserve les données partagées ; le Gateway exécute localement les opérations RouterOS autorisées.

## 2. Objectifs

- Administrer plusieurs Wi-Fi zones depuis une identité unique, avec séparation stricte des données par site.
- Synchroniser ventes, tickets, données techniques, clients et paramètres, sans doublons.
- Offrir un tableau de bord Web et des rapports financiers par période.
- Permettre les ventes assistées par vendeur et l'achat autonome depuis le portail captif.
- Intégrer les paiements Mobile Money après qualification contractuelle des fournisseurs.
- Maintenir un historique commercial fiable, distinct des données techniques du routeur.
- Permettre au client de consulter son achat et son forfait via un accès restreint.
- Fournir des analyses et recommandations sans laisser l'IA exécuter librement des commandes réseau.

## 3. Périmètre fonctionnel

### 3.1 Identité, sites et accès
- Authentification et gestion des sessions via Supabase Auth.
- Création d'un site (Wi-Fi zone) et rattachement de son propriétaire.
- Une identité peut appartenir à plusieurs sites, avec un rôle différent pour chacun.
- Rôles de référence : owner, admin, manager, seller, technician et viewer ; le rôle client dispose d'un accès séparé et limité.
- Invitations, acceptation, révocation et journalisation des changements.
- Contrôle des autorisations côté API et isolation PostgreSQL RLS ; l'interface seule ne constitue jamais une autorisation.

### 3.2 Routeurs et passerelles
- Enregistrer plusieurs routeurs par site et leurs métadonnées de compatibilité.
- Associer un Gateway Android ou Linux à un site et à un ou plusieurs routeurs autorisés.
- Permettre un téléphone comme passerelle temporaire lorsque l'application est active.
- Permettre un Gateway permanent pour l'automatisation continue.
- Afficher état, dernière activité, version logicielle et disponibilité.
- Révoquer un Gateway et bloquer ses nouvelles commandes.

### 3.3 Synchronisation
- Synchroniser ventes, tickets, données techniques, clients et paramètres selon les permissions et règles de confidentialité.
- Utiliser une outbox persistante sur les clients et une inbox dédupliquée côté Cloud.
- Chaque événement porte un UUID stable, site_id, device_id/source_id, type, version de schéma, date UTC et payload validé.
- Accuser réception seulement après validation et persistance.
- Gérer reprises, curseurs, événements retardés et conflits sans écraser une donnée autoritaire par un événement ancien.
- Conserver le fonctionnement local pendant les coupures Internet.

### 3.4 Ventes, tickets et finances
- Conserver commandes, ventes, tickets, paiements et écritures financières comme objets distincts.
- Relier chaque vente au site, au vendeur le cas échéant, au profil, au ticket et à la transaction correspondante.
- Fournir rapports par jour, mois et période personnalisée, avec filtres et exports.
- Conserver la devise d'origine de chaque transaction (CDF ou USD) ; ne jamais additionner des devises différentes sans conversion explicite et taux daté.
- Utiliser des montants en unités mineures entières et un code devise ; aucun calcul monétaire en virgule flottante.
- Journaliser les corrections par écritures compensatoires, sans effacer silencieusement l'historique.

### 3.5 Paiements Mobile Money
- Définir une interface commune de prestataire et des adaptateurs indépendants.
- Prévoir les parcours portail autonome et vente assistée par vendeur.
- Ne confirmer un paiement qu'après validation serveur du prestataire : webhook authentifié et, lorsque possible, vérification du statut auprès du fournisseur.
- Dédupliquer les webhooks et demandes avec des clés d'idempotence.
- Distinguer statut du paiement, création du ticket, activation sur le routeur et délivrance au client.
- Si le paiement est confirmé mais le Gateway indisponible, garder une commande payée en attente d'activation ; ne pas annoncer un ticket actif.
- M-Pesa, Airtel Money et Orange Money sont des pistes à qualifier. Aucun fournisseur ne sera figé avant confirmation des comptes marchands, contrats, sandbox, devises, frais et capacités de remboursement.

### 3.6 Portail captif et espace client
- Présenter les forfaits, prix, devise, durée et conditions du site.
- Permettre l'initiation d'une commande et du paiement selon les fournisseurs activés.
- Afficher une référence de commande et l'état réel du paiement.
- Donner au client un accès limité à son propre achat, ticket, reçu et état de forfait.
- Utiliser des jetons opaques, expirables et révocables ; empêcher l'énumération des tickets et des clients.
- Prévoir un walled garden minimal et tester les navigateurs captifs Android, iOS et ordinateurs.

### 3.7 Tableau de bord et assistance analytique
- Afficher ventes, recettes, tickets, clients, activité des routeurs et état des passerelles.
- Signaler la fraîcheur des données et les éléments non synchronisés.
- Permettre des questions analytiques en langage naturel sur les données accessibles à l'utilisateur.
- L'IA ne peut pas exécuter directement des commandes RouterOS ; toute action sensible passe par une commande typée, une autorisation et une confirmation requise.

## 4. Architecture cible

- Application mobile : Flutter/Dart, maintien de Mtandao Ticket et de son mode local.
- Backend : NestJS, API REST versionnée, modules métier séparés.
- Identité : Supabase Auth.
- Base : PostgreSQL/Supabase, RLS et migrations versionnées.
- Dashboard : Next.js.
- Gateway : agent autonome Go pour Linux et Android, avec adaptateur RouterOS.
- Synchronisation et traitements différés : outbox/inbox, workers et file persistante ; Redis seulement lorsque la charge le justifie.
- Temps réel : connexion sortante sécurisée du Gateway vers le Cloud ; WebSocket ou protocole équivalent après spécification.
- Aucun port d'administration MikroTik ne doit être exposé directement sur Internet.

Le backend démarre comme un monolithe modulaire. Le Gateway reste un composant séparé en raison de son cycle de vie et de son accès au réseau local.

## 5. Compatibilité MikroTik

- RouterOS API/API-SSL est l'interface de compatibilité principale pour RouterOS 6 et 7.
- REST RouterOS 7 peut être ajouté comme adaptateur facultatif ; il ne remplace pas la compatibilité RouterOS 6.
- Détecter les versions et capacités réelles.
- Utiliser un compte RouterOS dédié avec privilèges minimaux.
- Préférer API-SSL lorsque configuré ; limiter les adresses autorisées au LAN ou au réseau Gateway.
- Ne jamais transmettre de scripts arbitraires ni de commandes CLI libres depuis le Cloud.

## 6. Sécurité, confidentialité et audit

- Chaque donnée métier est liée à un site et vérifiée côté serveur.
- RLS est une défense supplémentaire, pas un remplacement de l'autorisation métier.
- Aucun secret service-role, mot de passe RouterOS ou secret Mobile Money dans Flutter, le navigateur ou Git.
- Secrets conservés dans un stockage sécurisé/KMS ; les appareils utilisent le stockage sécurisé du système.
- TLS obligatoire ; mTLS recommandé pour l'identité durable des Gateways.
- Commandes signées, typées, autorisées, limitées dans le temps et protégées contre le rejeu.
- Journaux expurgés des mots de passe, tokens et données sensibles.
- Audit des actions administratives, financières et réseau.
- Minimisation, consentement, durée de conservation et suppression contrôlée des données personnelles.

## 7. Modèle de données de référence

Entités principales attendues : users, sites, site_memberships, routers, gateways, gateway_credentials, voucher_batches, vouchers, orders, payments, payment_events, sales_ledger, customers, router_snapshots, sync_events, commands, audit_logs, site_payment_accounts et site_settings.

Les noms et structures physiques peuvent évoluer par migration, mais chaque ressource tenant doit porter ou référencer son site et faire l'objet de tests d'isolation.

## 8. Exigences non fonctionnelles et cibles initiales

| Domaine | Cible proposée | Vérification |
|---|---|---|
| Disponibilité Cloud | 99,5 % mensuel en bêta, à réévaluer | Monitoring et rapports d'incident |
| Synchronisation | P95 inférieur à 60 s après retour Internet pour les lots ordinaires | Tests de coupure et reprise |
| Commande routeur | P95 inférieur à 10 s si Gateway et routeur sont joignables | Mesure de bout en bout |
| Intégrité financière | Aucun paiement confirmé ou événement de vente dupliqué | Tests de concurrence et répétition webhook |
| Mode local | Fonctions essentielles disponibles sans Cloud | Tests LAN avec Internet coupé |
| Isolation tenant | Aucune lecture/écriture inter-sites | Tests API et RLS |
| Sauvegarde | RPO cible 24 h et RTO cible 8 h en première production | Test de restauration |
| Localisation | Français, fuseau horaire configurable par site | Tests de dates et journées commerciales |

Ces objectifs sont des cibles initiales, non des garanties de service avant mesure et validation.

## 9. Phases de réalisation

1. Audit fonctionnel et validation des flux existants.
2. Socle Cloud : authentification, sites, membres, rôles et audit.
3. Persistance locale, outbox/inbox et synchronisation.
4. Dashboard, rapports et rapprochement.
5. Passerelle téléphone et commandes typées.
6. Gateway permanent, enrôlement, heartbeat, connexion sortante et adaptateur RouterOS.
7. Vente assistée et adaptateur paiement sandbox.
8. Portail client et paiement autonome.
9. Assistant analytique IA.
10. Pilote sur un à trois sites, tests terrain, support et décision de généralisation.

Chaque lot doit livrer migrations, tests, documentation et critères de sortie. La mise en production des paiements attend la qualification du fournisseur et du compte marchand.

## 10. Critères d'acceptation essentiels

- Deux sites isolés : aucun utilisateur ne consulte les données d'un autre site.
- Invitation, acceptation et révocation respectent les rôles.
- Un événement de vente envoyé deux fois ne produit qu'une écriture.
- Un webhook dupliqué ne confirme qu'une seule transaction et ne crée pas deux tickets.
- Un faux webhook est rejeté.
- Paiement confirmé et Gateway absent : état payé/en attente, sans fausse activation.
- Les ventes locales réalisées hors connexion sont synchronisées une seule fois après reconnexion.
- Un Gateway révoqué ou suspendu ne peut pas envoyer de heartbeat valide ni recevoir de nouvelle commande.
- RouterOS 6 et 7 sont testés sur des équipements ou environnements représentatifs.
- Les fonctions essentielles locales restent accessibles lorsque le Cloud est indisponible.
- Les accès client expirés ou destinés à un autre ticket sont refusés.
- Les rapprochements paiement, caisse, vente et ticket signalent les écarts.

## 11. Risques et décisions à confirmer

- Fournisseurs Mobile Money, comptes marchands, KYC, frais, devises et remboursements.
- Politique de conservation des données et obligations comptables.
- Hébergeur, région, sauvegardes et objectifs de reprise.
- Matériel recommandé pour le Gateway Linux et contraintes de distribution Android.
- Politique de rotation et révocation des secrets Gateway.
- Modèle d'abonnement et de facturation par site.
- Inventaire terrain des fonctionnalités Mtandao Ticket déjà compilées, testées sur simulateur et validées sur MikroTik réel.

## 12. Gouvernance documentaire

Ce cahier des charges définit les objectifs et exigences produit. Les documents architecture, décisions, contrats API, schémas d'événements et guides techniques du dépôt détaillent leur mise en œuvre. En cas de changement, mettre à jour ce document et les contrats concernés dans le même changement de périmètre. Ne pas considérer une fonction décrite ici comme développée ou validée tant qu'un code, un test et un critère d'acceptation ne l'attestent pas.

## 13. Référentiel des dépôts

- Mtandao Ticket : https://github.com/chadracklonde/mtandao-ticket-app
- Mtandao Cloud : https://github.com/chadracklonde/mtandao-cloud
- Mtandao Gateway : https://github.com/chadracklonde/mtandao-gateway
