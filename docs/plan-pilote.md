# Plan du pilote terrain

Objectif : valider la plateforme sur 1 à 3 sites réels avant de la généraliser. Cette phase demande des équipements et des personnes ; ce document fixe le cadre, les mesures et les critères de décision.

## Principe : le Cloud s'ajoute, il ne remplace pas

Mikhmon et l'application Mtandao Ticket restent l'outil principal tant que le pilote n'est pas concluant. Le Cloud observe d'abord, puis prend progressivement en charge des opérations. À tout moment, le site peut continuer à vendre sans le Cloud.

## Phases

| Phase | Durée indicative | Contenu | Sortie |
| --- | --- | --- | --- |
| 0. Banc d'essai | 1 semaine | Un routeur de laboratoire en RouterOS 6 puis 7. Plan de test : `docs/lab-test-plan.md` du dépôt Gateway. Script `scripts/pilot-smoke.mjs`. | Matrice RouterOS remplie, aucun échec bloquant |
| 1. Observation | 1 à 2 semaines | Un site réel. Enrôlement du Gateway, synchronisation des ventes de l'application, rapports et rapprochement. **Aucune commande d'écriture** (`GATEWAY_COMMANDS_ENABLED=false`). | Rapports du Cloud = ventes réelles ; aucun écart inexpliqué |
| 2. Écriture limitée | 1 à 2 semaines | Commandes activées : création et désactivation de tickets depuis le Cloud (vente assistée, espèces). Pas de portail public. | Tickets Cloud fonctionnels sur le routeur, vente et expiration enregistrées |
| 3. Paiement réel | à définir | Après choix et qualification d'un fournisseur Mobile Money : portail client sur un seul site. | Critères ci-dessous |
| 4. Décision | 1 semaine | Bilan, go / no-go de la généralisation. | Décision écrite |

## Critères d'acceptation à constater sur le terrain

Repris du cahier des charges (§10). Chaque ligne doit être vérifiée et datée :

- [ ] Deux sites isolés : aucun utilisateur ne voit les données de l'autre.
- [ ] Invitation, acceptation et révocation respectent les rôles.
- [ ] Une vente envoyée deux fois ne produit qu'une écriture.
- [ ] Un webhook dupliqué ne confirme qu'un paiement et ne crée pas deux tickets *(couvert par `pilot-smoke.mjs`)*.
- [ ] Un faux webhook est rejeté *(idem)*.
- [ ] Paiement confirmé et passerelle absente : « payé / en attente », sans fausse activation.
- [ ] Les ventes réalisées hors connexion sont synchronisées une seule fois après reconnexion.
- [ ] Une passerelle révoquée ne reçoit plus de commande et son heartbeat est refusé.
- [ ] RouterOS 6 et 7 testés sur équipements.
- [ ] Les fonctions locales restent accessibles quand le Cloud est indisponible (couper l'accès Internet du site).
- [ ] Un accès client expiré ou destiné à un autre ticket est refusé.
- [ ] Les rapprochements signalent les écarts (en provoquer un volontairement).

## Mesures à suivre

| Mesure | Comment | Seuil d'alerte |
| --- | --- | --- |
| Disponibilité de la passerelle | panneau « Prêt pour la vente ? », état des routeurs | hors ligne plus de 5 minutes en journée |
| Paiements « en attente d'activation » | onglet Écarts (`payment_activation_stuck`) | plus de 1 heure |
| Écarts de rapprochement | onglet Écarts | tout écart non expliqué sous 24 h |
| Conflits de synchronisation ouverts | onglet Écarts | plus de 0 après 48 h |
| Écart ventes Cloud / caisse physique | comparaison quotidienne | tout écart |
| Délai d'activation d'un ticket payé | différence `paid_at` → activation | plus de 2 minutes |

## Rôles pendant le pilote

- **Responsable du pilote** : décide du passage de phase, tient le journal des incidents.
- **Responsable du site** : vendeur et premier support terrain, utilise le rôle `manager`.
- **Technicien réseau** : routeur, certificat, Gateway (`technician`).
- **Développement** : correction des anomalies ; accès au journal d'audit et aux écarts.

## Conditions d'arrêt immédiat

Interrompre la phase en cours (retour arrière : voir [mise-en-service.md](mise-en-service.md) §8) si : un ticket est créé deux fois, un client est débité sans ticket et sans trace, des données d'un site apparaissent sur un autre, ou un Gateway exécute une commande non prévue.

## Décision de généralisation

Go si, sur au moins deux semaines consécutives de la phase 2 : tous les critères ci-dessus sont cochés, aucun arrêt immédiat n'a eu lieu, les écarts ont tous été expliqués, et le responsable du site préfère l'usage du Cloud à l'ancien flux. Sinon, la liste des écarts devient le plan de correction du lot suivant.

## Points encore ouverts (à traiter avant la phase 3)

- Choix du fournisseur Mobile Money et qualification du compte marchand ; adaptateur de paiement réel (l'interface existe, voir [paiements.md](paiements.md)).
- Écran d'import du stock de tickets (aujourd'hui via l'API).
- Validation sur routeurs réels, en particulier le comportement du script on-login de l'application avec les tickets créés par le Gateway.
- Politique de conservation des données et mention d'information des clients (téléphone, achats).
