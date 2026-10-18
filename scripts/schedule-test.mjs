/**
 * Логіка графіків відключень, без мережі.
 *
 *   node scripts/schedule-test.mjs
 */
import {
  absoluteIntervals,
  classifyChange,
  dayIntervals,
  dueWarnings,
  EMERGENCY,
  emergencyEvent,
  encodeDay,
  formatMinutes,
  kyivLocalToMs,
  normalizeHouse,
  overlapSeconds,
  parseAddress,
  pickStreet,
  renderEmergency,
  renderSchedule,
  scheduleSnapshot,
} from '../lib/schedule.js';
import { renderScheduleSplit } from '../lib/messages.js';

let failures = 0;
function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? '✅' : '❌'} ${label}` +
      (ok ? '' : `\n   отримав:  ${JSON.stringify(actual)}\n   очікував: ${JSON.stringify(expected)}`)
  );
}

const MIN = 60000;
const span = (list) => list.map((i) => `${formatMinutes(i.from)}–${formatMinutes(i.to)}${i.kind === 'maybe' ? '?' : ''}`);

// --- години → проміжки ------------------------------------------------------

// Справжній графік групи 4.1 на 14.10.2026, як його віддало дзеркало ДТЕК.
const real = {};
'first yes yes yes yes yes yes yes yes yes yes yes yes yes yes yes yes no no no first yes yes yes'
  .split(' ')
  .forEach((value, index) => (real[String(index + 1)] = value));

const code = encodeDay(real);
expect('кодування доби', code, 'fyyyyyyyyyyyyyyyynnnfyyy');
expect('справжній графік 4.1 читається як на сайті ДТЕК', span(dayIntervals(code)), ['00:00–00:30', '17:00–20:30']);

expect('друга половина + перша половина злипаються', span(dayIntervals('ysfyyyyyyyyyyyyyyyyyyyyy')), ['01:30–02:30']);
expect('«точно» і «можливо» не злипаються', span(dayIntervals('nmyyyyyyyyyyyyyyyyyyyyyy')), ['00:00–01:00', '01:00–02:00?']);
expect('відключення до кінця доби', span(dayIntervals('yyyyyyyyyyyyyyyyyyyyyynn')), ['22:00–24:00']);
expect('день без відключень', dayIntervals('y'.repeat(24)), []);
expect('невідоме значення трактується як «можливо»', span(dayIntervals('?' + 'y'.repeat(23))), ['00:00–01:00?']);

// --- київський час ----------------------------------------------------------

const oct14 = 1791925200 * 1000; // 14.10.2026 00:00 за Києвом, ключ із дзеркала
expect('17:00 за Києвом улітку = 14:00 UTC', new Date(kyivLocalToMs(oct14, 17 * 60)).toISOString(), '2026-10-14T14:00:00.000Z');

// 25.10.2026 о 04:00 годинник переводять на 03:00, доба триває 25 годин.
const oct25 = Date.UTC(2026, 9, 24, 21);
expect('переведення на зимовий: 10:00 = 08:00 UTC', new Date(kyivLocalToMs(oct25, 600)).toISOString(), '2026-10-25T08:00:00.000Z');
expect('переведення на зимовий: 02:00 ще за літнім = 23:00 UTC', new Date(kyivLocalToMs(oct25, 120)).toISOString(), '2026-10-24T23:00:00.000Z');

// 29.03.2026 о 03:00 годинник переводять на 04:00, доба триває 23 години.
const mar29 = Date.UTC(2026, 2, 28, 22);
expect('переведення на літній: 10:00 = 07:00 UTC', new Date(kyivLocalToMs(mar29, 600)).toISOString(), '2026-03-29T07:00:00.000Z');

// --- перетин відключення з графіком -----------------------------------------

const days = [{ date: '2026-10-14', start: oct14, groups: { '4.1': code } }];
const off = absoluteIntervals(days, '4.1');
expect('абсолютні проміжки', off.map((i) => [new Date(i.start).toISOString().slice(11, 16), new Date(i.end).toISOString().slice(11, 16)]), [['21:00', '21:30'], ['14:00', '17:30']]);

const at = (h, m = 0) => kyivLocalToMs(oct14, h * 60 + m);
expect('світла не було 16:50–17:40: за графіком 40 хв', overlapSeconds(at(16, 50), at(17, 40), off), 40 * 60);
expect('відключення повністю поза графіком', overlapSeconds(at(12), at(13), off), 0);
expect('відключення, що накрило обидва проміжки', overlapSeconds(at(0), at(21), off), (30 + 210) * 60);
expect('порожній проміжок', overlapSeconds(at(18), at(18), off), 0);

// --- що робити із закріпленим ------------------------------------------------

const base = { messageId: 10, group: '4.1', days: { '2026-10-14': code, '2026-10-15': '-' }, text: 'A' };
expect('ще нічого не закріплено → новий допис', classifyChange(undefined, base), 'new');
expect('змінилась група → новий допис', classifyChange(base, { ...base, group: '5.1' }), 'new');
expect('нічого не змінилось → нічого', classifyChange(base, { ...base }), 'none');
expect('змінилась лише примітка → тихо переписати', classifyChange(base, { ...base, text: 'B' }), 'edit');
expect(
  'з\'явився графік на завтра → новий допис',
  classifyChange(base, { ...base, days: { '2026-10-14': code, '2026-10-15': 'y'.repeat(24) } }),
  'new'
);
expect(
  'ДТЕК змінив сьогоднішній графік → новий допис',
  classifyChange(base, { ...base, days: { '2026-10-14': 'y'.repeat(24), '2026-10-15': '-' } }),
  'new'
);
expect(
  'північ: нового графіка нема → новий допис без звуку',
  classifyChange(base, { ...base, days: { '2026-10-15': '-', '2026-10-16': '-' }, text: 'C' }),
  'quiet'
);
expect(
  'північ, а ДТЕК саме змінив години на сьогодні → новий допис зі звуком',
  classifyChange(
    { ...base, days: { '2026-10-14': code, '2026-10-15': 'y'.repeat(24) } },
    { ...base, days: { '2026-10-15': 'n'.repeat(24), '2026-10-16': '-' }, text: 'C' }
  ),
  'new'
);
expect(
  'північ, а на післязавтра графік уже є → новий допис',
  classifyChange(base, { ...base, days: { '2026-10-15': '-', '2026-10-16': 'n'.repeat(24) }, text: 'C' }),
  'new'
);
expect('закріплене видалили руками → новий допис', classifyChange({ ...base, messageId: null }, base), 'new');

// --- попередження -----------------------------------------------------------

const intervals = [{ start: 100 * MIN, end: 200 * MIN }];
expect('за 20 хв до відключення — пора', dueWarnings(intervals, [], 80 * MIN).length, 1);
expect('за 40 хв — ще зарано', dueWarnings(intervals, [], 60 * MIN).length, 0);
expect('вже попереджали — вдруге не треба', dueWarnings(intervals, [String(100 * MIN)], 80 * MIN).length, 0);
expect('відключення вже почалось — не попереджаємо', dueWarnings(intervals, [], 110 * MIN).length, 0);

// --- адреси -----------------------------------------------------------------

expect('адреса з комою', parseAddress('вул. Олеся Олександра, 2А'), { street: 'вул. Олеся Олександра', house: '2А' });
expect('адреса з «буд.»', parseAddress('Хрещатик буд. 22'), { street: 'Хрещатик', house: '22' });
expect('лише одне слово — не адреса', parseAddress('Хрещатик'), null);
expect('латинська «a» → кирилична', normalizeHouse('2a'), '2А');
expect('«2-А» → «2А»', normalizeHouse('2-А'), '2А');
expect('«2 а» → «2А»', normalizeHouse('2 а'), '2А');
expect('дріб лишається дробом', normalizeHouse('12/14'), '12/14');

const pobedy = [{ id: 1, value: 'вул. Перемоги' }, { id: 2, value: 'сел. Перемоги' }];
expect('«Перемоги» — неоднозначно', Boolean(pickStreet('Перемоги', pobedy).ambiguous), true);
expect('«вул. Перемоги» — точно', pickStreet('вул. Перемоги', pobedy).match?.id, 1);
expect('регістр не важить', pickStreet('ВУЛ. перемоги', pobedy).match?.id, 1);
expect('нічого не знайдено', pickStreet('х', []), { none: true });

// --- закріплене повідомлення ------------------------------------------------

const cache = { lastUpdated: new Date(at(16, 31)).toISOString(), dtekUpdate: '14.10.2026 14:05', days };
const snapshot = scheduleSnapshot(cache, '4.1', at(16, 45));
expect('сьогодні й завтра за Києвом', [snapshot.today, snapshot.tomorrow], ['2026-10-14', '2026-10-15']);
expect('завтрашнього графіка ще нема', snapshot.days['2026-10-15'], '-');

const text = renderSchedule({ group: '4.1', address: 'вул. Олеся Олександра, 2А', snapshot, cache, now: at(16, 45) });
expect('у графіку видно, на котру ДТЕК його опублікував', text.includes('Дані ДТЕК на 14.10.2026 14:05'), true);
expect('завтра не опубліковано — блоку «Завтра» нема зовсім', text.includes('Завтра'), false);

const published = renderSchedule({
  group: '4.1',
  snapshot: { ...snapshot, days: { ...snapshot.days, '2026-10-15': 'yyyyyyyynnnyyyyyyyyyyyyy' } },
  cache,
  now: at(20, 0),
});
expect('графік на завтра з\'явився — блок є', published.includes('Завтра, 15 жовтня</b>\n⚫ 08:00–11:00'), true);
expect('свіжі дані — без попередження', text.includes('⚠️'), false);
const stale = renderSchedule({ group: '4.1', snapshot, cache, now: at(16, 31) + 8 * 3600 * 1000 });
expect('дані старші за 6 годин — попередження', stale.includes('⚠️ Джерело не оновлювалось'), true);

// --- екстрені відключення ---------------------------------------------------

expect('уперше бачимо, а екстрені вже тривають', emergencyEvent(undefined, EMERGENCY), 'active');
expect('уперше бачимо, звичайний режим — мовчимо', emergencyEvent(undefined, 'ScheduleApplies'), null);
expect('почались', emergencyEvent('ScheduleApplies', EMERGENCY), 'started');
expect('скінчились', emergencyEvent(EMERGENCY, 'ScheduleApplies'), 'ended');
expect('скінчились, хоч слово й невідоме заздалегідь', emergencyEvent(EMERGENCY, 'WhateverYasnoSays'), 'ended');
expect('тривають далі — мовчимо', emergencyEvent(EMERGENCY, EMERGENCY), null);
expect('Yasno не відповів — це не скасування', emergencyEvent(EMERGENCY, null), null);

expect(
  'текст про скасування — як попросили',
  renderEmergency('ended', 'Києві'),
  '✅ Екстрені відключення скасовано\nВідключення відбуваються за графіком'
);
expect('текст про початок', renderEmergency('started', 'Києві').split('\n')[0], '🚨 У Києві почались екстрені відключення');

const withEmergency = renderSchedule({ group: '4.1', snapshot, cache, emergency: true, now: at(16, 45) });
expect('у закріпленому рядок про екстрені — одразу під заголовком', withEmergency.split('\n\n')[1], '🚨 Зараз діють екстрені відключення, графік може не виконуватись');

// --- звіт дня ---------------------------------------------------------------

expect('без графіка — без рядка', renderScheduleSplit(3600, undefined), null);
expect('усе за графіком', renderScheduleSplit(3600, 3600), '↳ усе за графіком');
expect('усе поза графіком', renderScheduleSplit(3600, 0), '↳ усе поза графіком');
expect('порівну', renderScheduleSplit(7200, 3600), '↳ за графіком 1 годину, поза графіком 1 годину');

console.log(failures === 0 ? '\nВсе зійшлось.' : `\nПровалів: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
