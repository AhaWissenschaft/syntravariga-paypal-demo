/**
 * SyntraVariga Health — Subsidy Calculator Domain Kernel
 * Evaluates German Social Code (SGB XI) benefits for seniors and caregivers.
 */

export interface SubsidyRequest {
  pflegegrad: number; // 0 to 5
  personCount: number; // 1 to 4
  measures: {
    stairModification: boolean; // § 40 Abs. 4 SGB XI (up to 4,180 EUR per person, max 16,720 EUR)
    emergencyCallButton: boolean; // § 40 Abs. 1 SGB XI (25.50 EUR / month)
    reliefAmount: boolean; // § 45b SGB XI (133 EUR / month)
    careSupplies: boolean; // § 40 Abs. 2 SGB XI (40 EUR / month)
  };
}

export interface SubsidyResult {
  isEligible: boolean;
  totalFirstYearEur: number;
  breakdown: {
    stairModificationEur: number;
    emergencyCallEur: number;
    reliefAmountEur: number;
    careSuppliesEur: number;
  };
  legalReferences: string[];
  summaryDe: string;
}

export function calculateSubsidies(req: SubsidyRequest): SubsidyResult {
  const { pflegegrad, personCount, measures } = req;

  if (pflegegrad < 1 || personCount < 1) {
    return {
      isEligible: false,
      totalFirstYearEur: 0,
      breakdown: {
        stairModificationEur: 0,
        emergencyCallEur: 0,
        reliefAmountEur: 0,
        careSuppliesEur: 0,
      },
      legalReferences: ["§ 40 SGB XI", "§ 45b SGB XI"],
      summaryDe: "Ohne anerkannten Pflegegrad (mindestens Grad 1) bestehen keine gesetzlichen Leistungsansprüche nach SGB XI.",
    };
  }

  // Cap person count at 4 for SGB XI § 40 Abs. 4 shared housing rule
  const cappedPersons = Math.min(Math.max(personCount, 1), 4);

  // 1. Stair & Living Environment Modification (§ 40 Abs. 4 SGB XI)
  // 4,180 EUR per person, up to 16,720 EUR for 4 people
  const stairEur = measures.stairModification ? Math.min(cappedPersons * 4180, 16720) : 0;

  // 2. Emergency Call System (§ 40 Abs. 1 SGB XI)
  // 25.50 EUR per month = 306 EUR per year
  const emergencyEur = measures.emergencyCallButton ? (306 * (cappedPersons > 1 ? 2 : 1)) : 0;

  // 3. Relief Amount / Entlastungsbetrag (§ 45b SGB XI)
  // 133 EUR per month = 1,596 EUR per year per person
  const reliefEur = measures.reliefAmount ? (1596 * cappedPersons) : 0;

  // 4. Care Supplies / Pflegehilfsmittel zum Verbrauch (§ 40 Abs. 2 SGB XI)
  // 40 EUR per month = 480 EUR per year per person
  const suppliesEur = measures.careSupplies ? (480 * cappedPersons) : 0;

  const total = stairEur + emergencyEur + reliefEur + suppliesEur;

  const references = [
    "§ 40 Abs. 4 SGB XI (Wohnumfeldverbesserung bis zu 4.180 € / 8.360 €)",
    "§ 40 Abs. 1 SGB XI (Hausnotruf-Grundgebühr 25,50 € / Monat)",
    "§ 45b SGB XI (Entlastungsbetrag 133 € / Monat = 1.596 € / Jahr)",
    "§ 40 Abs. 2 SGB XI (Pflegehilfsmittel zum Verbrauch bis zu 40 € / Monat)",
  ];

  return {
    isEligible: true,
    totalFirstYearEur: total,
    breakdown: {
      stairModificationEur: stairEur,
      emergencyCallEur: emergencyEur,
      reliefAmountEur: reliefEur,
      careSuppliesEur: suppliesEur,
    },
    legalReferences: references,
    summaryDe: `Gesamtförderanspruch im 1. Jahr: ${total.toLocaleString("de-DE")} € für ${cappedPersons} versicherte Person(en) ab Pflegegrad ${pflegegrad}.`,
  };
}

export function generateStairApplicationLetter(opts: {
  fullName: string;
  address: string;
  insuranceNumber: string;
  insuranceName: string;
  isPair: boolean;
}): string {
  const amount = opts.isPair ? "8.360,00 €" : "4.180,00 €";
  const dateStr = new Date().toLocaleDateString("de-DE");

  return `Absender:
${opts.fullName}
${opts.address}
Versichertennummer: ${opts.insuranceNumber}

An die Pflegekasse bei der
${opts.insuranceName}

Datum: ${dateStr}

Betreff: Antrag auf Zuschuss zur Verbesserung des individuellen Wohnumfeldes gemäß § 40 Abs. 4 SGB XI (Höchstbetrag ${amount})

Sehr geehrte Damen und Herren,

hiermit beantrage ich für meine häusliche Wohnsituation die Gewährung eines Zuschusses zur Wohnumfeldverbesserung nach § 40 Abs. 4 SGB XI in Höhe von bis zu ${amount}.

Begründung:
Infolge bestehender mobilitäts- und gleichgewichtsbezogener Einschränkungen stellt die Nutzung der Treppenanlage in meiner Wohnung eine erhebliche und tägliche Sturzgefahr dar. Die geplante Maßnahme (z. B. Einbau eines Treppenlifts bzw. Anbringung beidseitiger Sicherheits-Handläufe) ist zwingend erforderlich, um eine selbstständige Lebensführung im häuslichen Umfeld aufrechtzuerhalten und drohende Pflegeunfälle zu verhüten.

${opts.isPair ? "Hinweis: Da zwei anspruchsberechtigte Personen mit anerkanntem Pflegegrad im selben Haushalt leben, wird der gesetzlich vorgesehene Doppelbetrag von bis zu 8.360,00 € geltend gemacht." : ""}

Einen Kostenvoranschlag des Fachbetriebs reiche ich unmittelbar nach. Ich bitte um eine schriftliche Bestätigung des Antragseingangs vor Beginn der Arbeiten.

Mit freundlichen Grüßen

_________________________________
(Unterschrift)`;
}
