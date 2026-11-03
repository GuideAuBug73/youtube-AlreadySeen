# AlreadySeen – Marquer comme vu sur YouTube

Extension Chrome / Brave (Manifest V3) qui ajoute un bouton « Marquer comme vue » :

- **dans le lecteur** (contrôles en bas à droite),
- **sous la vidéo** (bouton « Marquer vue » à côté de Partager),
- **sur chaque vignette** (au survol, coin haut gauche) : accueil, recherche, chaînes, suggestions, playlists, Shorts.

Un second clic retire la marque.

## Ce qui se passe quand on marque une vidéo

1. **Synchro avec le compte YouTube** (activée par défaut). L'extension fait comme
   `yt-dlp --mark-watched` : elle récupère les adresses de suivi de lecture de la vidéo
   (`videostatsPlaybackUrl` / `videostatsWatchtimeUrl`) et signale à YouTube une lecture
   jusqu'à la fin. La vidéo arrive dans l'historique du compte et la barre rouge passe à 100 %,
   y compris sur vos autres appareils. Ça marche depuis les vignettes, sans ouvrir la vidéo.
   Il faut être connecté à YouTube dans le navigateur.
2. **Sur la page de la vidéo**, le lecteur est aussi mis en pause à la fin de la vidéo, pour que
   ses propres signaux (envoyés à la pause ou en quittant la page) ne ramènent pas la progression
   en arrière.
3. **Stockage local** (`chrome.storage.local`) : la vidéo est retenue pour toujours, ce qui permet
   d'afficher tout de suite la coche verte et une barre rouge pleine, même avant que YouTube ne
   rafraîchisse ses vignettes, et même si vous n'êtes pas connecté.

Retirer la marque (second clic) supprime la vidéo de l'historique du compte, comme le menu
« Supprimer de l'historique » de youtube.com/feed/history : la barre rouge disparaît aussi.
L'extension retrouve l'entrée en cherchant le titre dans l'historique. (Renvoyer une
« position 0 » ne marche pas : YouTube l'ignore une fois la vidéo vue en entier.)
Si c'est la vidéo en cours de lecture, le lecteur revient au début et se met en pause, sinon
il la remettrait dans l'historique au prochain signal.

Testé le 3 novembre 2026 avec un compte connecté : depuis une vignette (vidéos de 2 min, 18 min
et 2 h) et depuis le lecteur, la vidéo apparaît dans l'historique avec la barre rouge à 100 %.

## Forcer un avancement (clic droit)

- **Sur la barre de progression du lecteur** : « Sauvegarder l'avancement à mm:ss » (l'endroit
  cliqué) ou « Sauvegarder la position actuelle ». Le lecteur s'y place et se met en pause.
- **Sur le bouton d'une vignette** : 25 %, 50 %, 75 % ou une autre valeur (pourcentage ou temps,
  par exemple `40` ou `12:30`).

La barre rouge du compte passe à cette position, y compris en dessous d'une lecture complète.
Une position de quelques secondes seulement est ignorée par YouTube : pour revenir à zéro, il
faut retirer la marque. Testé le 3 novembre 2026 : 40 % depuis le lecteur, 75 % depuis une
vignette, la barre YouTube affiche 39 % et 74 % après rechargement.

## Options (icône de l'extension)

- Synchro compte YouTube, et saut à la fin (ou au début au retrait) sur la page vidéo.
- Afficher ou non chacun des trois boutons.
- Marquage automatique à X % de la lecture (90 % par défaut).
- Considérer comme vues les vidéos que YouTube affiche déjà avec une barre rouge ≥ X %.
- Assombrir les vignettes vues, ou les masquer des fils (jamais dans une playlist).
- Masquer les Shorts (étagères, cartes et entrée de menu ; jamais sur les pages Shorts ni sur
  l'onglet Shorts d'une chaîne). Activé par défaut, comme dans l'extension de référence.
- Masquer les vidéos « Réservé aux membres ». Le badge est reconnu par son icône étoile, donc
  quelle que soit la langue de YouTube. Désactivé par défaut.
- Masquer les « Jeux intégrés YouTube » (Playables) : étagères, cartes et entrée de menu, sauf
  sur les pages des jeux. Activé par défaut.
- Export / import JSON de la liste locale, et effacement.

## Installation (mode développeur)

1. Ouvrir `chrome://extensions` (ou `brave://extensions`).
2. Activer le **Mode développeur**.
3. **Charger l'extension non empaquetée** et choisir ce dossier `already-seen`.

## Organisation du code

- `src/page.js` : script dans le monde de la page (accès à `ytcfg`, au lecteur et aux cookies du
  compte). Il fait la synchro YouTube et le saut à la fin.
- `src/content.js` : interface (boutons, barre, assombrissement, masquage), liste locale,
  marquage automatique. Il parle à `page.js` par des `CustomEvent`.
- `src/shared.js` : réglages par défaut et accès au stockage, partagés avec la popup.
- `popup/` : la fenêtre de réglages.
