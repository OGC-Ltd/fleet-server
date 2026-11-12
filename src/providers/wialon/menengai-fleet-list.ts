/**
 * Menengai's own fleet list (MORL_FLEET_2.xlsx, 1 Nov 2026): one category per
 * tab, in the client's order. The same list new-ui reads from
 * src/data/fleetGroups.js. Change both together.
 *
 * These categories are Menengai's vehicle groups (wialon.unit-name
 * menengaiGroup), and IAM narrows a person's fleet access by them
 * (operator, 2026-11-12: "access to tankers or van sales or finished goods").
 *
 * Labels only: a plate, or a machine's short name ("FL 01") where it has none.
 * A unit listed in two tabs stays in the first.
 */
export const MENENGAI_FLEET_LIST: ReadonlyArray<{ name: string; units: readonly string[] }> = [
  { name: "Tankers", units: [
    "KCH 012A", "KCK 456G", "KCA 918P", "KCF 180A", "KCF 181A", "KCF 182A", "KCF 183A", "KCF 185A",
    "KCF 186A", "KCF 187A", "KCH 123B", "KCH 045A", "KCK 234F", "KCK 345G", "KCC 386Z", "KCM 123T",
    "KCM 234W", "KCM 234S", "KCN 901F", "KCN 902F", "KCN 903F", "KCN 904F", "KCN 906F", "KCN 907F",
    "KCN 908F", "KCN 909F", "KCN 910F", "KCN 911F", "KCN 912F", "KCN 913F", "KCN 914F", "KCN 916F",
    "KCN 345B", "KCT 507W", "KCT 508W", "KCT 509W", "KCT 510W", "KCT 511W", "KCT 512W", "KCV 029A",
    "KCV 033A", "KCV 036A", "KCV 039A", "KCV 041A", "KCV 042A", "KCV 044A", "KCV 051A", "KCV 052A",
    "KCV 053A", "KCV 056A", "KCV 070A", "KCV 071A", "KCV 901D",
  ] },
  { name: "Finished Goods", units: [
    "KBT 112R", "KBT 113R", "KBT 114R", "KBT 116R", "KBT 119R", "KCA 223M", "KCA 224M", "KCA 225M",
    "KCA 226M", "KCA 227M", "KBY 003A", "KBY 009A", "KBY 010A", "KBY 011A", "KBY 012A", "KBY 594Q",
    "KCC 385Z", "KCB 303Z", "KCA 915P", "KCA 917P", "KCA 919P", "KCF 184A", "KCM 810H", "KCP 042S",
    "KCP 043S", "KCP 044S", "KCP 065V", "KCP 129P", "KCP 131P", "KCP 132P", "KCP 133P", "KCP 134P",
    "KCP 135P", "KCP 136P", "KCP 145P", "KCA 456U", "KBT 117R", "KBY 006A", "KAX 536U", "KBE 726E",
    "KBB 161G", "KBZ 911V", "KBG 388E", "KBG 389E", "KBB 880A", "KDA 258J", "KCH 463T", "KCS 074M",
    "KCS 075M", "KCH 137K", "KCH 297K", "KCT 346W", "KCT 347W", "KCT 348W", "KCT 358W", "KCU 258L",
    "KCU 259L", "KCW 193E", "KCW 475E", "KBV 493K", "KBV 493A", "KBY 769G", "KCB 101Y", "KBT 255D",
    "KBY 710G", "KBV 494K", "KCB 100Y", "KBX 668R", "KBV 678M", "KCC 345A", "KCC 348A", "KCC 428K",
    "KCC 431K", "KCF 483V",
  ] },
  { name: "Van Sales", units: [
    "KCH 467T", "KCH 473T", "KCH 474T", "KCH 502T", "KDE 017U", "KDE 018U", "KDE 021U", "KDE 023U",
    "KDE 228P", "KDE 229P", "KDE 230P", "KDE 231P", "KDE 240P", "KDE 254P", "KDE 264S", "KDE 265S",
    "KDE 267P", "KDE 268P", "KDE 275S", "KDM 154L", "KDM 139L", "KDM 130L", "KDM 128L", "KDM 135L",
    "KDM 140L", "KDM 125L", "KDM 129L", "KDM 138L", "KDM 124L", "KDM 127L", "KDM 098L", "KDM 119L",
    "KDM 144L", "KDM 148L", "KCH 470T", "KCS 071M", "KCS 072M", "KCS 076M", "KCS 077M", "KCS 078M",
    "KCS 081M", "KCS 082M", "KCS 088M", "KCB 123P", "KCB 234J", "KCB 345K", "KDE 120E", "KDE 121E",
    "KDE 122E", "KDE 123E", "KDE 125E", "KDE 126E", "KDE 127E", "KDE 128E", "KDE 129E", "KDE 130E",
    "KDE 131E", "KDE 132E", "KDE 133E", "KDE 134E", "KDE 135E", "KDE 136E", "KDE 137E", "KDE 138E",
    "KDE 139E", "KDE 140E", "KDE 141E", "KDE 142E", "KDE 143E", "KDE 144E", "KDE 145E",
  ] },
  { name: "Light Vehicles", units: [
    "KBZ 043V", "KBD 370G", "KCA 172G", "KBT 194H", "KBT 325L", "KBT 448X", "KBY 782T", "KBS 860S",
    "KBH 593U", "KCX 555U", "KBS 565P", "KCS 840R", "KCS 842R", "KCS 843R", "KCY 074M", "KCY 403S",
    "KCY 082M", "KCG 527E", "KCG 271A", "KCG 549E", "KCL 234M", "KCL 968R", "KCL 016Z", "KCX 943E",
    "KCX 740D", "KCX 749D", "KCF 028Q", "KCF 073Q", "KCE 046Q", "KCF 931D", "KCZ 673E", "KCZ 290C",
    "KCG 638N", "KCF 906D", "KCF 740D", "KCF 851C", "KCG 223A", "KCY 599Z", "KCF 235C", "KCZ 288C",
    "KCF 186W", "KCE 780B", "KCG 625N", "KCF 567J", "KCD 456X", "KCL 610D", "KCF 750B", "KCH 123T",
    "KCH 234T", "KCH 345T", "KBX 667R", "KBY 345B", "KBT 789H", "KDD 200V", "KBT 049B", "KBT 069B",
    "KBT 678G",
  ] },
  { name: "Equipment", units: [
    "KBY 002A", "KBY 007A", "KBY 008A", "KCN 678J", "KCN 567J", "KCN 456J", "KBY 678B", "KBY 678D",
    "KBZ 234E", "KBX 456A", "KBV 487K", "KBY 679F", "JCB 01", "JCB 02", "EX 01", "EX 02",
    "CR 02", "KBV 789M", "KCM 234J", "KCG 345X", "KCG 678W",
  ] },
  { name: "Farm Equipment", units: [
    "KTCC 085A", "KBJ 510J", "KTCC 150F", "KTCC 108F", "YUVRAJ 215", "KTCB 165Y", "KTCC 389N", "KTCC 390N",
    "KMFG 498D", "KMFD 500D", "KMGB 614S", "KMGC 102B", "KMGC 814B", "KMFU 927U", "KTCC 429J", "FORKLIFT",
  ] },
  { name: "RAI MDF FG", units: [
    "KCP 070P", "KCP 071P", "KCP 073P", "KCP 075P", "KCP 077P", "KCP 086P", "KCP 104P", "KDJ 083J",
    "KDJ 099J", "KDJ 105J", "KDJ 106J", "KDJ 107J", "KDJ 108J",
  ] },
  { name: "RAI MDF Equipment", units: [
    "FL 01", "FL 02", "FL 03", "FL 04", "TRACTOR RELIEVER", "WL 01", "WL 01 RELIEVER", "WL 02",
    "WL 02 RELIEVER", "WL 03", "WL 03 RELIEVER", "KDJ 069X",
  ] },
]
