/**
 * Bascule l'envoi des e-mails de Directus dans .env, entre les blocs délimités par « # >>> » et « # <<< » :
 *   npm run email:reel      SMTP réel (Gmail ou autre)        — e-mails réellement envoyés
 *   npm run email:maildev   MailDev (http://localhost:1080)    — obligatoire pour les tests d'intégration
 * Redémarrer Directus ensuite. Aucune valeur du fichier n'est affichée.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2]
if (!['reel', 'maildev'].includes(mode)) { console.error('Usage : node scripts/mode-email.mjs reel|maildev'); process.exit(2) }
const fichier = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')
const lignes = fs.readFileSync(fichier, 'utf8').split('\n')

let bloc = null
let trouves = 0
const sortie = lignes.map((l) => {
  if (l.startsWith('# >>> e-mails réels')) { bloc = 'reel'; trouves++; return l }
  if (l.startsWith('# >>> e-mails de test')) { bloc = 'maildev'; trouves++; return l }
  if (l.startsWith('# <<<')) { bloc = null; return l }
  if (!bloc) return l
  const variable = /^(# )?(EMAIL_[A-Z_]+=.*)$/.exec(l)
  if (!variable) return l // commentaires explicatifs du bloc
  return bloc === mode ? variable[2] : `# ${variable[2]}`
})
if (trouves !== 2) { console.error('Blocs « # >>> e-mails réels » et « # >>> e-mails de test » introuvables dans .env : rien n’a été modifié.'); process.exit(1) }
fs.writeFileSync(fichier, sortie.join('\n'))
console.log(mode === 'reel'
  ? 'E-mails réels activés (SMTP du bloc « e-mails réels »). Redémarrez Directus.'
  : 'E-mails de test activés (MailDev, http://localhost:1080). Redémarrez Directus.')
