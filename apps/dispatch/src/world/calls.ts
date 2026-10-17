import type { Kind } from "../shared/city.ts";

/**
 * A kind of emergency: what callers say, what it truly needs, and what happens if nobody who can
 * help gets there in time. Needs are the world's truth; agents only ever see the words.
 */
export interface CallTemplate {
  texts: string[];
  needs: Partial<Record<Kind, number>>;
  severity: 1 | 2 | 3;
  /** Where it can happen (default anywhere). */
  where?: "bridge";
  escalation?: { text: string; add?: Partial<Record<Kind, number>> };
}

/** Shift seconds a call of each severity has before it is lost. */
export const WINDOW_S: Record<1 | 2 | 3, number> = { 1: 150, 2: 90, 3: 60 };

/** A call escalates once this share of its window passes with nobody it needs working the scene. */
export const ESCALATE_AT = 0.45;

export const CALLS: CallTemplate[] = [
  {
    texts: [
      "There's smoke pouring out of my neighbour's kitchen window and I can see flames.",
      "My kitchen's on fire, the pan went up and it's spreading to the cupboards.",
    ],
    needs: { fire: 1 },
    severity: 2,
    escalation: { text: "Caller: the flames have reached the flat upstairs.", add: { fire: 1 } },
  },
  {
    texts: [
      "There's a really strong smell of gas in our building and my mum feels dizzy and sick.",
      "It smells like rotten eggs in the stairwell and two of us have headaches and feel faint.",
    ],
    needs: { fire: 1, medical: 1 },
    severity: 3,
    escalation: { text: "Caller: someone has passed out on the landing." },
  },
  {
    texts: [
      "My husband just collapsed in the kitchen and he isn't breathing!",
      "A man fell down outside the bakery, he's not moving and I can't find a pulse.",
    ],
    needs: { medical: 1 },
    severity: 3,
  },
  {
    texts: [
      "Two cars smashed into each other at the junction, one driver is trapped and bleeding.",
      "Bad crash here, a car flipped onto its roof and the driver can't get out.",
    ],
    needs: { fire: 1, medical: 1, police: 1 },
    severity: 3,
  },
  {
    texts: [
      "Someone just smashed the window of the shop across the road and they're inside right now.",
      "I can hear someone breaking in downstairs, I'm hiding in the bedroom.",
    ],
    needs: { police: 1 },
    severity: 2,
    escalation: { text: "Caller: they're coming up the stairs, please hurry." },
  },
  {
    texts: ["A man is waving a knife outside the bar and there's a guy on the ground bleeding."],
    needs: { police: 1, medical: 1 },
    severity: 3,
  },
  {
    texts: [
      "A car alarm has been going off for an hour on our street and nobody's around.",
      "There's a van parked across my driveway again and I can't get out for work.",
    ],
    needs: { police: 1 },
    severity: 1,
  },
  {
    texts: [
      "My grandmother slipped in the bathroom, she's awake and talking but she can't get up.",
      "My dad fell off a ladder in the garden, he's conscious but his wrist looks broken.",
    ],
    needs: { medical: 1 },
    severity: 1,
    escalation: { text: "Caller: she's gone very pale and isn't making sense now." },
  },
  {
    texts: [
      "The smoke alarm next door has been screaming for ten minutes and the old lady who lives there isn't answering.",
    ],
    needs: { fire: 1, medical: 1 },
    severity: 2,
  },
  {
    texts: [
      "Some kids set a bin on fire behind the school and it's burning pretty high now.",
      "A skip full of rubbish is on fire in the car park.",
    ],
    needs: { fire: 1 },
    severity: 1,
    escalation: { text: "Caller: it's caught the fence and the shed next to it." },
  },
  {
    texts: ["There's a big fight in the street outside the club, about six people throwing punches."],
    needs: { police: 1 },
    severity: 2,
    escalation: { text: "Caller: one of them is on the ground now and his head is bleeding.", add: { medical: 1 } },
  },
  {
    texts: ["A van just hit a cyclist, he's awake but his leg is bent the wrong way, and the van drove off."],
    needs: { medical: 1, police: 1 },
    severity: 2,
  },
  {
    texts: [
      "The electricity box on the corner is sparking and there's smoke coming out of it.",
      "A power line came down in the wind and it's sparking on the pavement.",
    ],
    needs: { fire: 1 },
    severity: 2,
  },
  {
    texts: ["A toddler is locked in a car in the sun, she's crying and bright red, and nobody can find the owner."],
    needs: { fire: 1, medical: 1 },
    severity: 3,
  },
  {
    texts: ["My dad's got a crushing pain in his chest and he's sweating all over. He's 64."],
    needs: { medical: 1 },
    severity: 3,
  },
  {
    texts: ["My friend ate something with nuts in it and her throat is swelling up, she can barely breathe."],
    needs: { medical: 1 },
    severity: 3,
  },
  {
    texts: ["Someone left a backpack at the bus stop an hour ago and now it's making a ticking noise."],
    needs: { police: 1 },
    severity: 2,
  },
  {
    texts: ["I got fired today and my boss has followed me home. He's parked outside my house and won't leave."],
    needs: { police: 1 },
    severity: 2,
  },
  {
    texts: ["The old warehouse is completely on fire, flames are coming through the roof!"],
    needs: { fire: 2 },
    severity: 3,
  },
  {
    texts: ["There's a man standing on the wrong side of the bridge railing, he says he's going to jump."],
    needs: { police: 1, medical: 1 },
    severity: 3,
    where: "bridge",
  },
  {
    texts: ["Security caught a shoplifter at the supermarket, they're holding him in the office and he's calm."],
    needs: { police: 1 },
    severity: 1,
  },
  {
    texts: ["My flatmate took something and now he's barely breathing and his lips are going blue."],
    needs: { medical: 1 },
    severity: 3,
  },
  {
    texts: ["An old man in pyjamas is wandering down the middle of the road, he seems really confused."],
    needs: { police: 1 },
    severity: 2,
    escalation: { text: "Caller: a car nearly hit him and he's fallen over.", add: { medical: 1 } },
  },
  {
    texts: ["The neighbours' barbecue smoke keeps blowing into my garden and they won't stop when I ask."],
    needs: { police: 1 },
    severity: 1,
  },
  {
    texts: ["A gang of teenagers is throwing fireworks at passing cars."],
    needs: { police: 1 },
    severity: 2,
  },
  {
    texts: ["A water main has burst and the road is flooding, cars are getting stuck."],
    needs: { police: 1 },
    severity: 1,
  },
];
