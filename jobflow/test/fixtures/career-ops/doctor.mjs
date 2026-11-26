// Test stand-in for career-ops doctor.mjs --init-templates: writes one template file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.CAREER_OPS_ROOT;
mkdirSync(join(root, 'modes'), { recursive: true });
writeFileSync(join(root, 'modes', '_profile.md'), '# template profile\n');
console.log(JSON.stringify({ onboardingNeeded: true, data_root: root }));
