# Assistant analytique — Lot 9

Panneau « Assistant » du tableau de bord : le personnel pose une question en français (« Quelles sont les ventes de cette semaine ? », « Quels écarts dois-je traiter ? ») et obtient une réponse chiffrée appuyée sur les données du site. L'assistant est **en lecture seule** : il ne modifie rien.

## API

`POST /v1/sites/:siteId/assistant` — authentification Bearer, corps :

```json
{ "question": "Ventes de la semaine ?", "history": [{ "role": "user", "content": "…" }, { "role": "assistant", "content": "…" }] }
```

- `question` : 1 à 500 caractères. `history` (facultatif) : 12 tours au plus, 2 000 caractères chacun, rôles `user` ou `assistant` uniquement. Le serveur ne garde aucune conversation : le navigateur renvoie les derniers tours.
- Réponse : `{ "answer": "…", "toolsUsed": [{ "name", "input", "error" }], "usage": { "inputTokens", "outputTokens" } }`. `toolsUsed` montre quelles données ont été consultées.
- Erreurs : `400` entrée invalide, `401` jeton absent, `404` site inconnu ou non accessible, `429` trop de questions (6 par minute et 60 par heure et par utilisateur), `503` assistant non configuré ou indisponible, `502` échec côté modèle.

## Ce que l'assistant peut consulter

Sept outils, tous en lecture, qui réutilisent les routes existantes avec **le jeton de l'utilisateur** :

| Outil | Données |
| --- | --- |
| `get_sales_summary` | totaux par jour ou par mois et par devise (espèces / Mobile Money) |
| `get_reconciliation` | écarts de rapprochement : résumé par type et premiers écarts |
| `list_recent_sales` | dernières ventes |
| `list_payments` | paiements Mobile Money et état de livraison |
| `get_pricing` | tarifs des cinq durées standard et stock |
| `get_stock` | stock de tickets par forfait |
| `list_routers` | passerelles, liaison routeur, dernière activité |

Il n'existe aucun outil qui écrit, annule, rembourse ou exécute une commande.

## Sécurité

- **Périmètre = le site de l'utilisateur.** L'identifiant du site est fixé par l'URL et n'est jamais un paramètre d'outil : le modèle ne peut pas interroger un autre site. Les outils s'exécutent avec le jeton de l'utilisateur, donc les mêmes règles que le reste de la plateforme s'appliquent (accès par ligne en base, rôles). Un vendeur qui demande le chiffre d'affaires obtient une explication, pas les chiffres. Un non-membre est refusé (`404`) avant tout appel au modèle.
- **Données sensibles masquées.** Les codes de tickets, les numéros de téléphone des clients et les identifiants d'appareils sont retirés de tous les résultats avant d'être transmis au modèle.
- **Entrées des outils validées** : dates ISO, groupes et statuts connus, nombre de lignes plafonné à 50, paramètres inconnus refusés.
- **Boucle bornée** : 6 allers-retours avec le modèle et 8 appels d'outils au plus par question ; résultats tronqués à 30 000 caractères.
- **Injection de consignes** : les résultats d'outils sont déclarés comme des données dans l'instruction système (un nom de forfait ou de routeur contenant une consigne doit être ignoré). Comme l'assistant ne peut rien écrire, le pire effet reste une réponse trompeuse.
- **Pas de secret dans les erreurs** : un refus d'authentification auprès du fournisseur est journalisé pour l'opérateur et renvoyé à l'utilisateur comme « assistant indisponible ».

## Confidentialité

Les questions et les chiffres consultés (totaux, montants, statuts, noms de forfaits et de routeurs) sont envoyés à l'API d'Anthropic pour produire la réponse. L'interface le rappelle sous le champ de saisie. L'utilisateur reste responsable de ce qu'il tape dans sa question.

## Configuration

| Variable | Rôle |
| --- | --- |
| `ANTHROPIC_API_KEY` | clé de l'API Claude, **secret serveur**. Sans elle l'assistant répond `503`. |
| `ASSISTANT_MODEL` | modèle utilisé. Par défaut `claude-opus-5-5`. |
| `ASSISTANT_DISABLED=true` | coupe l'assistant sans retirer la clé. |

Avec `claude-opus-5-5`, le repli automatique en cas de refus des classificateurs de sécurité est activé (`fallbacks: "default"`), la réflexion adaptative est celle par défaut du modèle, et l'effort est réglé sur `medium`. Si vous choisissez un autre modèle, ces options ne sont envoyées que lorsque le modèle les accepte.

**Coût** : une question peut provoquer jusqu'à six appels au modèle (un par outil consulté, plus la réponse finale). Un modèle moins cher (`ASSISTANT_MODEL=claude-sonnet-5-5` ou `claude-haiku-5-5`) réduit la facture ; la limite de 6 questions par minute et par utilisateur borne la consommation.

## Limites actuelles

- **Non testé avec la vraie API Claude** : aucune clé n'était disponible. La boucle est testée avec un faux client scripté, et le vrai SDK a été exercé de bout en bout contre un faux serveur Claude (format des requêtes, en-têtes, en-tête bêta de repli, aucun paramètre refusé par les modèles récents). La qualité réelle des réponses reste à évaluer avec une clé et vos données.
- Pas de mémoire côté serveur, pas de graphiques, français uniquement.
- La limitation de débit est en mémoire et propre à chaque instance de l'API.
- L'assistant ne voit que les rapports existants : pas de comparaison automatique entre sites, pas de prévision.

Tests : `apps/api/src/assistant/assistant.service.spec.ts`.
