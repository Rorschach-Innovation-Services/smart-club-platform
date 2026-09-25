/**
 * Longer explainers for the questions operators and admins actually ask about league
 * structures (ADR 0008 and its addenda). Each topic is short enough to read in a popover
 * and concrete enough to check against a real fixture list.
 *
 * `guideAnchor` is the `id` of a heading in public/guides/league-structures-tutorial.html
 * (served at /guides/league-structures-tutorial.html). Renaming an id there breaks the
 * "Read more in the guide" link here, so change both together.
 */

export interface HelpTopic {
  id: string;
  title: string;
  /** One or two sentences — enough on its own. */
  summary: string;
  /** Two to five short paragraphs. */
  body: string[];
  /** A worked example with real-looking clubs and dates. */
  example?: string;
  guideAnchor?: string;
}

export type HelpTopicId =
  | 'how-dates-are-planned'
  | 'home-and-away'
  | 'knockout-seeding'
  | 'semi-final-pairing'
  | 'standings-typed-by-human'
  | 'venue-allocation'
  | 'approve-release-withhold'
  | 'activate-from'
  | 'what-regenerate-destroys'
  | 'structure-versions-and-rebase'
  | 'blocks-vs-stages'
  | 'legacy-series'
  | 'competition-defaults';

export const HELP_TOPICS: Record<HelpTopicId, HelpTopic> = {
  'how-dates-are-planned': {
    id: 'how-dates-are-planned',
    guideAnchor: 'schedule',
    title: 'How fixture dates are planned',
    summary:
      'Each stage plays inside one block of the season calendar, at its cadence. Breaks and excluded dates push rounds later. They never drop them.',
    body: [
      'A stage names its block by position: Block 1, Block 2. The first round goes on the block’s first date. After that, one round per cadence step: weekly, every N weeks, on set weekdays, or spread evenly to the block’s last date.',
      'When a round lands on a break or an excluded date, it moves to the next free date. A ten-round league still gets ten rounds, just later.',
      'If the rounds run past the block’s last date, the stage does not fit. The preview says how many rounds are over, so you can shorten the cadence, extend the block or move the stage.',
      'A stage set to start after the previous stage keeps the same weekday. It skips every date up to the previous stage’s last round.',
    ],
    example:
      'Block 1 runs 13 Sep – 13 Dec 2026, and 13 Sep is a Sunday. A weekly stage plays 13 Sep, 20 Sep, 27 Sep and so on. If 27 Sep is excluded, that round moves to 4 Oct and every later round moves back a week.',
  },
  'home-and-away': {
    id: 'home-and-away',
    guideAnchor: 'format',
    title: 'Who plays at home',
    summary:
      'Home and away swap every second round. The pairings match union spreadsheets, but which side is at home deliberately differs in the even-numbered rounds.',
    body: [
      'A round robin pairs sides by the circle method, the same method union spreadsheets use. Every round’s pairings match the spreadsheet exactly.',
      'Home and away then swap every second round. In round 1 the first-listed side of each pair is at home; in round 2 the other side is. This keeps most clubs close to half home, half away.',
      'Union spreadsheets do not swap, so in rounds 2, 4, 6 and so on the platform’s home side is the spreadsheet’s away side. This is on purpose.',
      'In a double round robin the second leg repeats the first with every fixture reversed, so each pair plays once at each ground. Check the home and away balance report before release.',
    ],
    example:
      'Round 1: Westville v Berea Rovers at Westville. The spreadsheet keeps Westville at home in round 2 as well. The platform makes Westville the away side in round 2, against Crusaders at Crusaders.',
  },
  'knockout-seeding': {
    id: 'knockout-seeding',
    guideAnchor: 'format',
    title: 'How a knockout is seeded',
    summary:
      'A seeded knockout pairs by rank and keeps seeds 1 and 2 apart until the final. A field that is not 2, 4, 8 or 16 is trimmed by a preliminary round among the lowest seeds.',
    body: [
      'In a bracket of 8 the first round is 1 v 8, 4 v 5, 2 v 7 and 3 v 6. Seeds 1 and 2 sit in opposite halves, so they can only meet in the final.',
      'A bracket needs 2, 4, 8 or 16 sides. When the field is another size, the lowest seeds play a preliminary round to trim it down. The top seeds go straight through.',
      'The platform has no results, so the admin types the seeding order when the stage opens. Later rounds read “Winner of Quarter-final 1” and so on, because the platform cannot know who won.',
      'The union’s own spreadsheet pairs its semi-finals so that seeds 1 and 2 could meet early. The platform uses the standard bracket instead. The quarter-finals are the same; only the semi-final pairing differs.',
    ],
    example:
      'Kingsmead Cup, 9 sides: seeds 8 and 9 play a preliminary match. The winner joins seeds 1 to 7 in the quarter-finals, then semi-finals and a final.',
  },
  'semi-final-pairing': {
    id: 'semi-final-pairing',
    guideAnchor: 'confirming-entrants',
    title: 'Semi-finals: within-group or cross-group',
    summary:
      'Two groups sending two sides each can be paired two ways. Cross-group is A1 v B2 and B1 v A2; within-group is A1 v A2 and B1 v B2.',
    body: [
      'Cross-group: each group winner plays the other group’s runner-up. Sides from the same group cannot meet again until the final.',
      'Within-group: each group plays its own semi-final. The two group winners meet in the final.',
      'The structure sets a default. The admin can choose the other pairing when confirming the qualifiers, and that choice applies to this season only.',
      'In this version, within-group needs exactly 2 groups sending 2 sides each.',
    ],
    example:
      'Group A: Westville 1st, Crusaders 2nd. Group B: Berea Rovers 1st, Glenwood 2nd. Cross-group gives Westville v Glenwood and Berea Rovers v Crusaders. Within-group gives Westville v Crusaders and Berea Rovers v Glenwood.',
  },
  'standings-typed-by-human': {
    id: 'standings-typed-by-human',
    guideAnchor: 'standings',
    title: 'Why the admin types the standings',
    summary:
      'The platform does not record scores, so it cannot work out who finished where. Any stage that depends on finishing order stops and asks the admin.',
    body: [
      'There is no results model and no log. A stage that depends on finishing order, such as a mid-season swap or semi-finals, cannot work itself out.',
      'So it stops and asks. It quotes the rule written into the structure, suggests the best grouping it honestly can, and waits for the admin to confirm.',
      'The admin types each side’s finishing position in the Position column. That order decides who plays whom in the next stage.',
      'Every confirmation is recorded against the admin’s name: what was suggested, what was chosen and when.',
    ],
    example:
      'After the double round, the admin confirms the swap: 6th in the Top Six moves down, 1st in the Bottom Six moves up, and each carries the points of the position it takes.',
  },
  'venue-allocation': {
    id: 'venue-allocation',
    guideAnchor: 'allocating-grounds',
    title: 'How grounds are allocated',
    summary:
      'Allocation runs after fixtures exist. It tries the home ground first and falls back in a fixed order, and every fixture gets a reason.',
    body: [
      'For each fixture it tries the home side’s ground, then that club’s secondary ground, then the away side’s ground, then the nearest free neutral ground.',
      'It looks at every series in the union at once. Two competitions cannot book the same ground past its capacity, or the same side twice on one day.',
      'Every fixture carries a reason. A fixture it cannot place is marked unresolved, not put somewhere wrong.',
      'A ground set by hand is kept. Running allocation again never moves it.',
    ],
    example:
      'Westville’s ground is closed on 3 Oct 2026 while the outfield is relaid. Westville v Crusaders that day moves to Crusaders’ ground, with the reason “Home ground outfield relaid — moved to the away side’s ground.”',
  },
  'approve-release-withhold': {
    id: 'approve-release-withhold',
    guideAnchor: 'running-a-season',
    title: 'Approve, release and withhold',
    summary:
      'Clubs see nothing until a series is approved and released. Withholding releases the dates but hides grounds and start times until the admin reveals them.',
    body: [
      'Generated fixtures start as a draft. Clubs and players see nothing until the admin approves and releases the series.',
      'At release the admin can withhold venues, start times or both. Clubs see “to be confirmed” until the admin reveals them.',
      'A withheld fixture still books its real ground. The clash check sees it, so nobody else can take that ground on that day.',
      'What a series withholds is fixed at release. To change it, recall the series and release it again.',
    ],
    example:
      'Premier Men T20 is released on 1 Sep 2026 with venues withheld. Clubs see “Sun 13 Sep 2026 · venue to be confirmed”. Kingsmead is still booked for that match, so no other fixture can be placed there that day.',
  },
  'activate-from': {
    id: 'activate-from',
    guideAnchor: 'schedule',
    title: 'Show fixtures to clubs from a date',
    summary:
      'An activation date hides a released series from clubs until that date. The fixtures exist and the admin can see them the whole time.',
    body: [
      'A stage can carry an activation date. Its fixtures are generated and released as normal, but clubs do not see them until that date.',
      'Use it when a competition is planned early but should stay out of sight, such as junior fixtures that start in the second block.',
      'Nothing else changes. Grounds are still booked and the clash check still sees the fixtures.',
    ],
    example:
      'Junior fixtures are generated and released on 1 Sep 2026 with an activation date of 18 Jan 2027. Clubs see them from 18 Jan, when Block 2 starts.',
  },
  'what-regenerate-destroys': {
    id: 'what-regenerate-destroys',
    guideAnchor: 'generating',
    title: 'What regenerating replaces',
    summary:
      'Regenerating rebuilds every fixture in a stage’s series. Allocated venues and hand-edited dates are lost, and there is no undo.',
    body: [
      'Regenerating rebuilds a stage’s fixtures from its structure and confirmed teams. It replaces every fixture in the stage’s series.',
      'Anything changed by hand on those fixtures is lost: allocated venues, moved dates and edited start times.',
      'If the series is already released, clubs see the new schedule at once. The console asks first and says how many series are affected.',
      'To fix one fixture, edit that fixture. Do not regenerate.',
    ],
    example:
      'A released Top Six series has its venues allocated and one rained-off match moved to 29 Nov 2026. Regenerating puts that match back on its planned date and clears every venue, so allocation has to be run again.',
  },
  'structure-versions-and-rebase': {
    id: 'structure-versions-and-rebase',
    guideAnchor: 'start-a-season',
    title: 'Structure versions and rebase',
    summary:
      'A season keeps a copy of the structure it started with. Rebase moves a running season onto the latest version without touching its series.',
    body: [
      'Every save that changes a structure gives it a new version. A season takes a copy when it starts, so later edits never reshape a season already running.',
      'Rebase moves a running season onto the latest version. The server fetches the structure itself, and refuses if it changed again after you reviewed it.',
      'Existing series are never touched. A stage whose teams setting changed goes back to awaiting entrants. A stage whose schedule changed is marked “Needs regenerating”.',
      'The calendar is not rebased. A season keeps the calendar copy it started with.',
    ],
    example:
      'Premier Men’s season started on version 3. The operator moves the final round to Block 2, which makes version 4. Rebase moves the season to version 4 and marks the final round “Needs regenerating”. The Top Six fixtures already released stay as they are.',
  },
  'blocks-vs-stages': {
    id: 'blocks-vs-stages',
    guideAnchor: 'part-one',
    title: 'Blocks and stages',
    summary:
      'A block is a stretch of dates on the calendar. A stage is a phase of play. Each stage plays in one block.',
    body: [
      'A block is a stretch of the season calendar, such as Block 1, 13 Sep – 13 Dec 2026. It says when play can happen.',
      'A stage is a phase of a competition, such as a round-robin stage or a knockout stage. It says who plays whom.',
      'Each stage plays in one block. Two stages can share a block, one after the other, or sit in different blocks either side of a break.',
    ],
    example:
      'KZNCU Premier Men T20 plays its round-robin stage in Block 1 and its knockout stage in Block 2, after the mid-season break. EMCU Division 1 30 Over plays both stages in Block 1, with the semi-finals starting the week after the groups finish.',
  },
  'legacy-series': {
    id: 'legacy-series',
    guideAnchor: 'binding',
    title: 'Series made without a structure',
    summary:
      'A league with no competition bound to it uses the older flow: the admin creates a series and gets one flat round robin.',
    body: [
      'A league with no competition bound uses Create a series. That gives one flat round robin, as it always has.',
      'These series work as before. Approval, release, ground allocation and broadcasts behave the same.',
      'They are not part of a season run, so they have no stages. Rebase and “Needs regenerating” do not apply to them.',
      'Regenerating one follows the calendar block it was created against, including any later edits to that calendar.',
    ],
    example:
      'EMCU Division 4 has no competition bound. The admin uses Create a series, picks Block 1 and every 2 weeks, and gets 11 rounds for 12 sides.',
  },
  'competition-defaults': {
    id: 'competition-defaults',
    title: 'How the platform uses your defaults',
    summary:
      'Competition defaults are the union’s own answers to questions the platform would otherwise answer with built-in values: formats, match days, start times, travel cost and ground spellings.',
    body: [
      'Match formats are offered when an admin starts a season. The first one is the default, and picking one fills in its overs and ball type.',
      'Match days and start times are filled in when a stage plays on set days only or has set start times. They are a starting point, not a rule: every stage can still change them.',
      'Travel cost prices the travel estimates on the fixtures screens and exports. A series that carries its own figures keeps them.',
      'Venue aliases tell the clash check that two spellings are one ground, so a fixture at either books the same field.',
      'Anything left empty uses the built-in value. Changing a default never changes a season or structure that already exists.',
    ],
    example:
      'A union sets its formats to 50 Over (Red Ball) and T20 (Pink Ball), and its match days to Saturday and Sunday. Starting a season now offers those two formats, and a stage set to set days only starts with Saturday and Sunday ticked.',
  },
};
