import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calculateSubsidies, generateStairApplicationLetter } from "./subsidyCalculator.js";

describe("SyntraVariga Health — Subsidy Calculator Tests", () => {
  test("returns zero when pflegegrad is 0", () => {
    const res = calculateSubsidies({
      pflegegrad: 0,
      personCount: 1,
      measures: {
        stairModification: true,
        emergencyCallButton: true,
        reliefAmount: true,
        careSupplies: true,
      },
    });

    assert.equal(res.isEligible, false);
    assert.equal(res.totalFirstYearEur, 0);
  });

  test("calculates full single-person entitlement for Pflegegrad 1", () => {
    const res = calculateSubsidies({
      pflegegrad: 1,
      personCount: 1,
      measures: {
        stairModification: true,
        emergencyCallButton: true,
        reliefAmount: true,
        careSupplies: true,
      },
    });

    assert.equal(res.isEligible, true);
    assert.equal(res.breakdown.stairModificationEur, 4180);
    assert.equal(res.breakdown.emergencyCallEur, 306);
    assert.equal(res.breakdown.reliefAmountEur, 1596);
    assert.equal(res.breakdown.careSuppliesEur, 480);
    assert.equal(res.totalFirstYearEur, 4180 + 306 + 1596 + 480); // 6,562 EUR
  });

  test("calculates double-benefit (8,360 EUR) for couples with Pflegegrad", () => {
    const res = calculateSubsidies({
      pflegegrad: 2,
      personCount: 2,
      measures: {
        stairModification: true,
        emergencyCallButton: true,
        reliefAmount: true,
        careSupplies: true,
      },
    });

    assert.equal(res.isEligible, true);
    assert.equal(res.breakdown.stairModificationEur, 8360);
    assert.equal(res.breakdown.emergencyCallEur, 612);
    assert.equal(res.breakdown.reliefAmountEur, 3192);
    assert.equal(res.breakdown.careSuppliesEur, 960);
    assert.equal(res.totalFirstYearEur, 8360 + 612 + 3192 + 960); // 13,124 EUR
  });

  test("caps stair modification at 16,720 EUR for group households (4+ people)", () => {
    const res = calculateSubsidies({
      pflegegrad: 1,
      personCount: 5, // higher than 4
      measures: {
        stairModification: true,
        emergencyCallButton: false,
        reliefAmount: false,
        careSupplies: false,
      },
    });

    assert.equal(res.breakdown.stairModificationEur, 16720);
  });

  test("generates formal application letter with accurate legal references", () => {
    const letter = generateStairApplicationLetter({
      fullName: "Max Mustermann",
      address: "Musterstr. 1, 10115 Berlin",
      insuranceName: "AOK Nordost",
      insuranceNumber: "A123456789",
      isPair: true,
    });

    assert.ok(letter.includes("Max Mustermann"));
    assert.ok(letter.includes("8.360,00 €"));
    assert.ok(letter.includes("§ 40 Abs. 4 SGB XI"));
    assert.ok(letter.includes("AOK Nordost"));
  });
});
