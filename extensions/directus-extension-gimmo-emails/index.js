/**
 * Hook G-immo : e-mails système de Directus (réinitialisation, inscription, invitation) en français ou en anglais.
 * Les corps sont dans ../../templates/*.liquid (EMAIL_TEMPLATES_PATH) ; version anglaise : <nom>-en.liquid.
 * Langue du destinataire : lien du site public en /en/…, sinon langue prévue à l'invitation, sinon son profil,
 * sinon le pays de son entreprise, sinon le français. L'objet n'est remplacé que s'il s'agit de l'objet par défaut de
 * Directus (un objet personnalisé, par exemple envoyé par un Flow, est conservé).
 */
import { langueMemorisee, langueUtilisateur } from '../../lib/gimmo/i18n.js'

const DEFAULT_SUBJECTS = {
  'password-reset': ['Password Reset Request'],
  'user-registration': ['Verify your email address'],
  'user-invitation': ["You've been invited"],
}
const SUBJECTS = {
  fr: { 'password-reset': 'Réinitialisation de votre mot de passe', 'user-registration': 'Confirmez votre adresse e-mail', 'user-invitation': 'Votre accès à l’espace professionnel' },
  en: { 'password-reset': 'Reset your password', 'user-registration': 'Confirm your email address', 'user-invitation': 'Your access to the business area' },
}

export default ({ filter }, { database }) => {
  filter('email.send', async (email) => {
    const name = email?.template?.name
    if (!name || !SUBJECTS.fr[name]) return email
    const dest = String((Array.isArray(email.to) ? email.to[0] : email.to)?.address ?? (Array.isArray(email.to) ? email.to[0] : email.to) ?? '').toLowerCase()
    let langue = /\/en\//.test(String(email.template.data?.url ?? '')) ? 'en' : langueMemorisee(dest)
    if (!langue) {
      const u = dest ? await database('directus_users').whereRaw('lower(email) = ?', [dest]).first('id') : null
      langue = u ? await langueUtilisateur(database, u.id) : 'fr'
    }
    // invitation d'un locataire (site public) : objet propre à l'espace locataire
    const locataire = name === 'user-invitation' && !/administration-gocleus/.test(String(email.template.data?.url ?? ''))
    const objet = locataire ? (langue === 'en' ? 'Your online tenant account' : 'Votre espace locataire en ligne') : SUBJECTS[langue][name]
    const subject = !email.subject || DEFAULT_SUBJECTS[name].includes(email.subject) ? `${objet} — Gocleus Immo` : email.subject
    return { ...email, subject, template: { ...email.template, name: langue === 'en' ? `${name}-en` : name, data: { ...email.template.data, langue } } }
  })
}
