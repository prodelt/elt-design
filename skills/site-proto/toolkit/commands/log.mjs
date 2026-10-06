import { SpError } from '../lib/out.mjs';
import { advance, describe, setNext } from '../lib/run.mjs';

export const summary = 'Close the current phase and open the next one (the checkpoint gate), or set NEXT.';

export const help = `sp log done
sp log next "<text>"

done   closes the current phase and opens the next one; both times go to run.json and to the
       timings table in run-log.md. Refuses with error "gate" and the list of missing artifacts
       while the next phase's requirements are not met. After the last phase the run is finished.
next   sets NEXT, the resume pointer sp status prints: what the next session does first.`;

export async function run(ctx) {
  const [verb, ...words] = ctx.positionals;
  const run = await ctx.requireRun();
  if (verb === 'done') {
    const moved = advance(run);
    return { from: moved.from, to: moved.to, ...describe(run) };
  }
  if (verb === 'next' && words.length) {
    setNext(run, words.join(' '));
    return describe(run);
  }
  throw new SpError('usage', 'expected: sp log done | sp log next "<text>"', { hint: 'sp log --help' });
}
