/**
 * G-immo — analytics : estimation par comparables (marché de la plateforme, anonymisé) et synthèse d'une agence.
 *
 * Estimation « comparables-v1 » :
 *  - prix au m² des biens du même type, dans le même quartier (sinon la même ville), sur toute la plateforme :
 *      location : baux en cours, annonces de location publiées, loyers de référence déclarés ;
 *      vente    : annonces de vente publiées, valeurs vénales déclarées, lots des programmes ;
 *    une seule valeur par bien et par nature (priorité : bail > annonce > valeur déclarée) ;
 *  - médiane × surface, fourchette = 1er–3e quartile, ajustement selon l'état du bien ;
 *  - aucun résultat sous 5 comparables ; seuls des agrégats sortent du calcul (aucune donnée d'une agence n'est exposée).
 *
 * Montants en unité mineure de la devise du pays de la ville (bigint en base, Number ici).
 */
import { isoDate, todayIso } from './commun.js'

export const VERSION_MODELE = 'comparables-v1'
export const MIN_COMPARABLES = 5
export const AJUSTEMENT_ETAT = { excellent: 1.1, bon: 1, moyen: 0.9, a_renover: 0.75 }
export const TYPES_BIEN = ['villa', 'maison', 'appartement', 'studio', 'bureau', 'local_commercial', 'terrain']

/** Quantile (interpolation linéaire) d'une liste triée. */
function quantile(tries, q) {
  const pos = (tries.length - 1) * q
  const bas = Math.floor(pos), haut = Math.ceil(pos)
  return tries[bas] + (tries[haut] - tries[bas]) * (pos - bas)
}

const surfaceDe = (type, habitable, terrain) => Number(type === 'terrain' ? terrain : habitable) || 0

/**
 * Prix au m² comparables d'une ville (toutes agences), par bien : { location: [{ bien, quartier, m2 }], vente: [...] }.
 * exclure : bien à ne pas compter (celui que l'on estime).
 */
async function comparables(db, { type_bien, ville, exclure = null }) {
  const location = new Map(), vente = new Map()
  const garder = (carte, cle, quartier, prix, surface) => {
    if (carte.has(cle) || !(Number(prix) > 0) || !(surface > 0)) return
    carte.set(cle, { quartier: quartier ?? null, m2: Number(prix) / surface })
  }
  const biens = (q) => q.where('b.type_bien', type_bien).where('b.ville', ville).modify(x => { if (exclure) x.whereNot('b.id', exclure) })

  // location : baux en cours, puis annonces publiées, puis loyers de référence
  for (const r of await biens(db('baux as l').join('biens as b', 'b.id', 'l.bien')).whereIn('l.statut', ['en_vigueur', 'litige'])
    .select('b.id', 'b.quartier', 'b.type_bien', 'b.surface_habitable', 'b.surface_terrain', 'l.loyer_hors_charges as prix')) garder(location, r.id, r.quartier, r.prix, surfaceDe(type_bien, r.surface_habitable, r.surface_terrain))
  for (const r of await biens(db('annonces as a').join('biens as b', 'b.id', 'a.bien')).where('a.statut', 'publiee').whereNot('a.prix_a_partir_de', true)
    .select('a.type_transaction', 'b.id', 'b.quartier', 'b.surface_habitable', 'b.surface_terrain', 'a.prix')) {
    garder(r.type_transaction === 'vente' ? vente : location, r.id, r.quartier, r.prix, surfaceDe(type_bien, r.surface_habitable, r.surface_terrain))
  }
  for (const r of await biens(db('biens as b')).whereNot('b.statut', 'archive')
    .select('b.id', 'b.quartier', 'b.surface_habitable', 'b.surface_terrain', 'b.loyer_reference', 'b.valeur_venale')) {
    const s = surfaceDe(type_bien, r.surface_habitable, r.surface_terrain)
    garder(location, r.id, r.quartier, r.loyer_reference, s)
    garder(vente, r.id, r.quartier, r.valeur_venale, s)
  }
  // vente : lots des programmes (prix catalogue, hors lots bloqués)
  for (const r of await db('lots as l').join('programmes as p', 'p.id', 'l.programme').where('l.type_bien', type_bien).where('p.ville', ville)
    .whereNot('l.statut', 'bloque').whereNot('p.statut_publication', 'brouillon').select('l.id', 'p.quartier', 'l.surface', 'l.prix')) garder(vente, `lot:${r.id}`, r.quartier, r.prix, Number(r.surface) || 0)

  return { location: [...location.values()], vente: [...vente.values()] }
}

/** Statistiques d'une liste de prix au m² : quartier d'abord, ville ensuite ; null sous le seuil. */
function statistiques(liste, quartier) {
  const duQuartier = quartier ? liste.filter(c => c.quartier === quartier) : []
  const [niveau, retenus] = duQuartier.length >= MIN_COMPARABLES ? ['quartier', duQuartier] : ['ville', liste]
  if (retenus.length < MIN_COMPARABLES) return { niveau: null, n: retenus.length }
  const tries = retenus.map(c => c.m2).sort((a, b) => a - b)
  return { niveau, n: tries.length, mediane: quantile(tries, 0.5), p25: quantile(tries, 0.25), p75: quantile(tries, 0.75) }
}

/** Indice de confiance (20–95 %) : nombre de comparables, niveau géographique, dispersion. */
export function confiance(s) {
  if (!s?.niveau) return null
  let c = s.n >= 30 ? 80 : s.n >= 15 ? 72 : s.n >= 10 ? 65 : 55
  if (s.niveau === 'quartier') c += 10
  const dispersion = s.mediane ? (s.p75 - s.p25) / s.mediane : 1
  c -= dispersion > 0.6 ? 20 : dispersion > 0.4 ? 12 : dispersion > 0.25 ? 5 : 0
  return Math.max(20, Math.min(95, Math.round(c)))
}

/** Devise du pays d'une ville. */
export async function deviseVille(db, ville) {
  return db('villes as v').join('pays as p', 'p.id', 'v.pays').join('devises as d', 'd.id', 'p.devise').where('v.id', ville)
    .first('d.id', 'd.code', 'd.symbole', 'd.decimales')
}

/**
 * Estimation d'un bien : { loyer, vente, rendement, confiance, niveau, nb_comparables, devise } ou levée d'une erreur de saisie.
 * Les montants sont arrondis à l'unité de la devise (multiple de 10^decimales en unité mineure).
 */
export async function estimer(db, { type_bien, ville, quartier = null, surface, etat = 'bon', exclure = null }) {
  const devise = await deviseVille(db, ville)
  const facteur = AJUSTEMENT_ETAT[etat] ?? 1
  const unite = 10 ** Number(devise?.decimales ?? 0)
  // arrondi « commercial » : 2 chiffres significatifs au-delà de 1 000 unités
  const arrondir = (v) => {
    const u = v / unite
    const pas = u >= 1e6 ? 1e4 : u >= 1e5 ? 1e3 : u >= 1e4 ? 500 : u >= 1000 ? 100 : 1
    return Math.round(u / pas) * pas * unite
  }
  const { location, vente } = await comparables(db, { type_bien, ville, exclure })
  const calcul = (liste) => {
    const s = statistiques(liste, quartier)
    if (!s.niveau) return { disponible: false, nb_comparables: s.n }
    return {
      disponible: true, niveau: s.niveau, nb_comparables: s.n, confiance: confiance(s),
      valeur: arrondir(s.mediane * surface * facteur), min: arrondir(s.p25 * surface * facteur), max: arrondir(s.p75 * surface * facteur),
      m2: Math.round(s.mediane),
    }
  }
  const loyer = calcul(location), prix = calcul(vente)
  const rendement = loyer.disponible && prix.disponible && prix.valeur > 0 ? Math.round(loyer.valeur * 12 / prix.valeur * 1000) / 10 : null
  const principale = loyer.disponible ? loyer : prix.disponible ? prix : null
  return {
    loyer, vente: prix, rendement, devise,
    confiance: principale?.confiance ?? null, niveau: principale?.niveau ?? null,
    nb_comparables: (loyer.nb_comparables ?? 0) + (prix.nb_comparables ?? 0),
  }
}

/** Ligne de la collection estimations pour un résultat. */
export function ligneEstimation(entree, r, extra = {}) {
  return {
    type_bien: entree.type_bien, ville: entree.ville, quartier: entree.quartier ?? null, surface: entree.surface, nb_chambres: entree.nb_chambres ?? null,
    etat: entree.etat ?? null, equipements: Array.isArray(entree.equipements) ? JSON.stringify(entree.equipements.slice(0, 20)) : null,
    loyer_estime: r.loyer.disponible ? r.loyer.valeur : null, fourchette_min: r.loyer.disponible ? r.loyer.min : null, fourchette_max: r.loyer.disponible ? r.loyer.max : null,
    valeur_venale_estimee: r.vente.disponible ? r.vente.valeur : null, fourchette_vente_min: r.vente.disponible ? r.vente.min : null, fourchette_vente_max: r.vente.disponible ? r.vente.max : null,
    rendement_estime: r.rendement, indice_confiance: r.confiance, nb_comparables: r.nb_comparables, niveau_comparaison: r.niveau,
    version_modele: VERSION_MODELE, devise: r.devise?.id ?? null, ...extra,
  }
}

/** Contrôle d'une demande d'estimation (corps JSON) → entrée normalisée, ou message d'erreur. */
export async function lireEntree(db, b) {
  const type_bien = String(b?.type_bien ?? '')
  if (!TYPES_BIEN.includes(type_bien)) return { erreur: 'Type de bien invalide.' }
  const ville = Number(b?.ville)
  if (!Number.isInteger(ville) || !await db('villes').where({ id: ville }).first('id')) return { erreur: 'Choisissez la ville.' }
  let quartier = b?.quartier ? Number(b.quartier) : null
  if (quartier && !await db('quartiers').where({ id: quartier, ville }).first('id')) return { erreur: 'Ce quartier n’appartient pas à la ville choisie.' }
  const surface = Number(b?.surface)
  if (!(surface >= 5 && surface <= 100000)) return { erreur: 'Indiquez une surface entre 5 et 100 000 m².' }
  const etat = b?.etat ? String(b.etat) : 'bon'
  if (!AJUSTEMENT_ETAT[etat]) return { erreur: 'État du bien invalide.' }
  const nb = b?.nb_chambres === undefined || b?.nb_chambres === null || b?.nb_chambres === '' ? null : Number(b.nb_chambres)
  if (nb !== null && !(Number.isInteger(nb) && nb >= 0 && nb <= 50)) return { erreur: 'Nombre de chambres invalide.' }
  const equipements = Array.isArray(b?.equipements) ? b.equipements.map(String).map(s => s.slice(0, 40)).slice(0, 20) : null
  return { entree: { type_bien, ville, quartier, surface, etat, nb_chambres: nb, equipements } }
}

// ── Synthèse d'une agence ─────────────────────────────────────────────────────────

const debutMois = (y, m) => new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)
const finMois = (y, m) => new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10)
const joursEntre = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
const num = (v) => Number(v ?? 0)

/**
 * Synthèse analytique d'une agence (12 derniers mois, prévision à 6 mois, entonnoir commercial, anomalies, rentabilité).
 * Lecture directe en base : l'appelant a déjà été contrôlé (endpoint /gimmo/analytics/synthese).
 */
export async function synthese(db, agence, jour = todayIso()) {
  const [y, m] = jour.split('-').map(Number)
  const debut12 = debutMois(y, m - 12)
  const devise = await db('agences as a').join('pays as p', 'p.id', 'a.pays').join('devises as d', 'd.id', 'p.devise').where('a.id', agence)
    .first('d.id', 'd.code', 'd.symbole', 'd.decimales')

  // échéances de loyer (12 derniers mois et à venir) et paiements confirmés
  const echeances = (await db('echeances').where({ agence }).whereNotNull('bail').whereNot('statut', 'annulee')
    .where('date_echeance', '>=', debut12).select('id', 'bail', 'date_echeance', 'montant_du', 'statut'))
    .map(e => ({ ...e, date_echeance: isoDate(e.date_echeance), montant_du: num(e.montant_du) }))
  const payes = new Map((await db('paiements').where({ agence, statut: 'confirme' }).whereIn('echeance', echeances.map(e => e.id).concat(['00000000-0000-0000-0000-000000000000']))
    .groupBy('echeance').select('echeance').sum({ total: 'montant' })).map(p => [p.echeance, num(p.total)]))
  const echues = echeances.filter(e => e.date_echeance <= jour && e.date_echeance >= debut12)
  const du12 = echues.reduce((s, e) => s + e.montant_du, 0)
  const regle12 = echues.reduce((s, e) => s + Math.min(payes.get(e.id) ?? 0, e.montant_du), 0)
  const recouvrement = du12 ? regle12 / du12 : null

  // 12 mois : appelé / encaissé (date d'échéance)
  const mois = []
  for (let i = 11; i >= 0; i--) {
    const d = debutMois(y, m - 1 - i), f = finMois(y, m - 1 - i)
    const du = echeances.filter(e => e.date_echeance >= d && e.date_echeance <= f)
    mois.push({ cle: d.slice(0, 7), du: du.reduce((s, e) => s + e.montant_du, 0), encaisse: du.reduce((s, e) => s + Math.min(payes.get(e.id) ?? 0, e.montant_du), 0) })
  }

  // prévision 6 mois : échéances déjà générées, sinon loyer + charges des baux en cours ; encaissement attendu = dû × taux de recouvrement
  const baux = (await db('baux as l').join('biens as b', 'b.id', 'l.bien').where('b.agence', agence).whereIn('l.statut', ['en_vigueur', 'litige'])
    .select('l.id', 'l.reference', 'l.bien', 'l.date_debut', 'l.date_fin', 'l.loyer_hors_charges', 'l.provision_charges', 'l.renouvellement_tacite', 'l.locataire', 'b.titre', 'b.type_bien', 'b.ville', 'b.quartier', 'b.surface_habitable', 'b.surface_terrain', 'b.etat'))
    .map(l => ({ ...l, date_debut: isoDate(l.date_debut), date_fin: isoDate(l.date_fin) }))
  const taux = recouvrement ?? 1
  const prevision = []
  for (let i = 0; i < 6; i++) {
    const d = debutMois(y, m - 1 + i), f = finMois(y, m - 1 + i)
    const generees = echeances.filter(e => e.date_echeance >= d && e.date_echeance <= f)
    const avecEcheance = new Set(generees.map(e => e.bail))
    const projete = baux.filter(l => !avecEcheance.has(l.id) && l.date_debut <= f && (!l.date_fin || l.date_fin >= d || l.renouvellement_tacite))
      .reduce((s, l) => s + num(l.loyer_hors_charges) + num(l.provision_charges), 0)
    const du = generees.reduce((s, e) => s + e.montant_du, 0) + projete
    // le mois en cours : ce qui est déjà encaissé compte en plus de l'attendu sur le reste
    const deja = i === 0 ? generees.reduce((s, e) => s + Math.min(payes.get(e.id) ?? 0, e.montant_du), 0) : 0
    prevision.push({ cle: d.slice(0, 7), du, attendu: Math.round(deja + (du - deja) * taux) })
  }

  // parc et occupation
  const biens = await db('biens').where({ agence }).whereNot('statut', 'archive').select('id', 'titre', 'reference', 'statut', 'type_bien', 'valeur_venale', 'date_created', 'surface_habitable', 'surface_terrain', 'loyer_reference')
  const loues = new Set(baux.map(l => l.bien))
  const louables = biens.filter(b => !['vendu', 'brouillon'].includes(b.statut) && b.type_bien !== 'terrain')
  const occupation = louables.length ? louables.filter(b => loues.has(b.id)).length / louables.length : null

  // rentabilité par bien (12 mois) : encaissé, coût des interventions, rendements bruts et nets sur la valeur vénale
  const encaisseParBail = new Map()
  for (const e of echues) encaisseParBail.set(e.bail, (encaisseParBail.get(e.bail) ?? 0) + Math.min(payes.get(e.id) ?? 0, e.montant_du))
  const bailDe = new Map((await db('baux').whereIn('id', [...encaisseParBail.keys()].concat(['00000000-0000-0000-0000-000000000000'])).select('id', 'bien')).map(b => [b.id, b.bien]))
  const encaisseParBien = new Map()
  for (const [bail, v] of encaisseParBail) { const b = bailDe.get(bail); if (b) encaisseParBien.set(b, (encaisseParBien.get(b) ?? 0) + v) }
  const couts = new Map((await db('tickets_maintenance as t').join('biens as b', 'b.id', 't.bien').where('b.agence', agence).where('t.statut', 'resolu')
    .whereIn('t.imputation', ['proprietaire', 'agence']).where('t.date_resolution', '>=', debut12).groupBy('t.bien').select('t.bien').sum({ cout: 't.cout' })).map(c => [c.bien, num(c.cout)]))
  const rentabilite = biens.filter(b => loues.has(b.id) || encaisseParBien.has(b.id)).map(b => {
    const bail = baux.find(l => l.bien === b.id)
    const loyerAnnuel = bail ? (num(bail.loyer_hors_charges)) * 12 : null
    const encaisse = encaisseParBien.get(b.id) ?? 0, cout = couts.get(b.id) ?? 0
    const valeur = num(b.valeur_venale)
    return {
      bien: b.id, titre: b.titre, reference: b.reference, encaisse, maintenance: cout, net: encaisse - cout,
      rendement_brut: valeur && loyerAnnuel ? Math.round(loyerAnnuel / valeur * 1000) / 10 : null,
      rendement_net: valeur ? Math.round((encaisse - cout) / valeur * 1000) / 10 : null,
    }
  }).sort((a, b) => b.net - a.net)

  // entonnoir commercial (12 mois)
  const compte = async (q) => num((await q.count({ n: '*' }).first())?.n)
  const depuis = `${debut12}T00:00:00Z`
  const entonnoir = {
    annonces: await compte(db('annonces').where({ agence, statut: 'publiee' })),
    demandes: await compte(db('demandes').where({ agence }).where('date_created', '>=', depuis)),
    prospects: await compte(db('prospects as p').join('contacts as c', 'c.id', 'p.contact').where('c.agence', agence).where('p.date_created', '>=', depuis)),
    visites: await compte(db('visites').where({ agence, statut: 'effectuee' }).where('date_visite', '>=', depuis)),
    conclus: await compte(db('baux as l').join('biens as b', 'b.id', 'l.bien').where('b.agence', agence).whereNotIn('l.statut', ['brouillon', 'en_attente_signature']).where('l.date_debut', '>=', debut12))
      + await compte(db('prospects as p').join('contacts as c', 'c.id', 'p.contact').where('c.agence', agence).where('p.etape', 'gagne').where('p.type_transaction', 'achat').where('p.date_updated', '>=', depuis)),
  }

  // anomalies (règles explicites ; chaque alerte renvoie vers l'élément concerné)
  const anomalies = []
  const retards = new Map()
  for (const e of echues) if ((payes.get(e.id) ?? 0) < e.montant_du && joursEntre(e.date_echeance, jour) > 5) retards.set(e.bail, (retards.get(e.bail) ?? 0) + 1)
  for (const l of baux) {
    const n = retards.get(l.id) ?? 0
    if (n >= 2) anomalies.push({ type: 'impayes_repetes', gravite: n >= 3 ? 'haute' : 'moyenne', titre: `${n} loyers impayés`, detail: `${l.titre} · bail ${l.reference ?? ''}`.trim(), lien: `/administration-gocleus/contrats/${l.id}` })
    if (l.date_fin && !l.renouvellement_tacite) {
      const reste = joursEntre(jour, l.date_fin)
      if (reste >= 0 && reste <= 60) anomalies.push({ type: 'fin_de_bail', gravite: reste <= 30 ? 'haute' : 'moyenne', titre: `Bail se terminant dans ${reste} j`, detail: `${l.titre} · sans renouvellement tacite`, lien: `/administration-gocleus/contrats/${l.id}` })
    }
  }
  // loyer nettement sous le marché (comparables de la plateforme, hors ce bien)
  for (const l of baux.slice(0, 40)) {
    const surface = surfaceDe(l.type_bien, l.surface_habitable, l.surface_terrain)
    if (!surface || !num(l.loyer_hors_charges)) continue
    const r = await estimer(db, { type_bien: l.type_bien, ville: l.ville, quartier: l.quartier, surface, etat: l.etat ?? 'bon', exclure: l.bien })
    if (r.loyer.disponible && num(l.loyer_hors_charges) < r.loyer.valeur * 0.8) {
      const ecart = Math.round((1 - num(l.loyer_hors_charges) / r.loyer.valeur) * 100)
      anomalies.push({ type: 'sous_le_marche', gravite: 'basse', titre: `Loyer ${ecart} % sous le marché`, detail: `${l.titre} · médiane des ${r.loyer.nb_comparables} comparables`, lien: `/administration-gocleus/biens/${l.bien}`, marche: r.loyer.valeur, loyer: num(l.loyer_hors_charges) })
    }
  }
  // vacance : bien louable, sans bail en cours depuis plus de 60 jours
  const finsDeBail = new Map((await db('baux as l').join('biens as b', 'b.id', 'l.bien').where('b.agence', agence).whereIn('l.statut', ['resilie', 'termine'])
    .groupBy('l.bien').select('l.bien').max({ fin: 'l.date_fin' })).map(r => [r.bien, isoDate(r.fin)]))
  for (const b of louables.filter(b => !loues.has(b.id) && b.statut === 'disponible')) {
    const depuisLe = finsDeBail.get(b.id) ?? isoDate(b.date_created)
    const j = depuisLe ? joursEntre(depuisLe, jour) : 0
    if (j > 60) anomalies.push({ type: 'vacance', gravite: j > 120 ? 'haute' : 'moyenne', titre: `Vacant depuis ${j} j`, detail: b.titre, lien: `/administration-gocleus/biens/${b.id}` })
  }
  // relevé de gérance validé et non payé depuis plus de 15 jours
  for (const r of await db('reversements').where({ agence, statut: 'valide' }).select('id', 'numero', 'date_validation', 'montant_net')) {
    const j = r.date_validation ? joursEntre(isoDate(r.date_validation), jour) : 0
    if (j > 15) anomalies.push({ type: 'reversement_en_attente', gravite: j > 30 ? 'haute' : 'moyenne', titre: `Reversement non payé depuis ${j} j`, detail: `Relevé ${r.numero ?? ''}`.trim(), lien: `/administration-gocleus/reversements/${r.id}` })
  }
  const ordre = { haute: 0, moyenne: 1, basse: 2 }
  anomalies.sort((a, b) => ordre[a.gravite] - ordre[b.gravite])

  return {
    devise, jour,
    indicateurs: {
      encaisse12: regle12, du12, recouvrement, occupation, biens: biens.length, loues: louables.filter(b => loues.has(b.id)).length, louables: louables.length,
      impayes: echues.reduce((s, e) => s + Math.max(0, e.montant_du - (payes.get(e.id) ?? 0)), 0),
      prevision6: prevision.reduce((s, p) => s + p.attendu, 0),
    },
    mois, prevision, rentabilite: rentabilite.slice(0, 20), entonnoir, anomalies,
  }
}
