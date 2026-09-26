/**
 * yarn staff — create a staff account or change someone's dashboard role.
 *
 *   yarn staff ada@edmira.com admin --password 'S3cure!pass' --name "Ada Obi"
 *   yarn staff reviewer@uni.edu reviewer        # promote an existing account
 *   yarn staff someone@uni.edu none             # remove staff access
 *   yarn staff you@edmira.com admin --name "New Name"   # rename (shown in the dashboard)
 *
 * Roles: admin | creator | reviewer | none. Uses MONGODB_URI (from .env).
 */
import * as bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { SALT_ROUNDS } from '../common/config/constants';
import { StaffRole } from '../common/enum/staff-role.enum';
import { userModel } from '../users/model/user.model';

function parseArgs(argv: string[]) {
  const [email, role] = argv;
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { email: email?.trim().toLowerCase(), role, password: flag('password'), name: flag('name') };
}

async function main() {
  const { email, role, password, name } = parseArgs(process.argv.slice(2));
  const roles = [...Object.values(StaffRole), 'none'];
  if (!email || !roles.includes(role)) {
    throw new Error(`Usage: yarn staff <email> <${roles.join('|')}> [--password P] [--name "First Last"]`);
  }
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI (e.g. in .env).');

  await mongoose.connect(process.env.MONGODB_URI);
  const User = mongoose.model('User', userModel);
  const newRole = role === 'none' ? undefined : role;
  let user = await User.findOne({ email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });

  if (user) {
    user.set('role', newRole);
    if (password) user.set('password', await bcrypt.hash(password, SALT_ROUNDS));
    if (name) {
      const [firstName, ...rest] = name.trim().split(/\s+/);
      user.set({ firstName, lastName: rest.join(' ') });
    }
    await user.save();
    const shownName = [user.get('firstName'), user.get('lastName')].filter(Boolean).join(' ');
    console.log(`${user.get('email')} (${shownName || 'no name'}) → ${newRole ?? 'no staff access'}`);
  } else {
    if (!newRole) throw new Error(`No account for ${email}.`);
    if (!password || password.length < 10) {
      throw new Error('New staff accounts need --password with at least 10 characters.');
    }
    const [firstName, ...rest] = (name ?? email.split('@')[0]).split(' ');
    user = await User.create({
      email,
      password: await bcrypt.hash(password, SALT_ROUNDS),
      firstName,
      lastName: rest.join(' '),
      username: email.split('@')[0],
      role: newRole,
      isVerified: true,
    });
    console.log(`Created ${newRole} account ${email}`);
  }
  await mongoose.disconnect();
}

main().catch(error => {
  console.error(error.message ?? error);
  process.exit(1);
});
