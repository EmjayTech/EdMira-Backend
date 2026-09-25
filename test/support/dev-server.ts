/**
 * yarn dev:memory — run the whole backend locally with zero setup.
 *
 * - In-memory MongoDB (data is lost when you stop the server)
 * - Sample courses, quizzes and news loaded
 * - A demo student: demo@edmira.com / Demo!2345
 * - Dashboard staff: admin@ / creator@ / reviewer@edmira.com, password Staff!2345
 * - Emails are NOT sent; verification / reset codes are printed here
 */
process.env.NODE_ENV = 'development';

import { startInMemoryApp } from './in-memory-app';
import { seedSampleContent } from '../../src/seed/seed-sample-content';
import { AuthService } from '../../src/auth/auth.service';
import { UserType } from '../../src/common/enum/user-type.enum';

const PORT = Number(process.env.PORT ?? 4000);
const DEMO = { email: 'demo@edmira.com', password: 'Demo!2345' };
const STAFF_PASSWORD = 'Staff!2345';

async function main() {
  const server = await startInMemoryApp({ logEmails: true });
  const seeded = await seedSampleContent(server.connection);

  const auth = server.app.get(AuthService);
  await auth.signup({
    email: DEMO.email,
    password: DEMO.password,
    firstName: 'Demo',
    lastName: 'Student',
    username: 'demo',
    userType: UserType.STUDENT,
    countryCode: '+234',
    phoneNumber: '8012345678',
    studentProfile: {
      institution: 'University of Lagos',
      faculty: 'Faculty of Clinical Sciences',
      department: 'Medicine & Surgery (MBBS)',
      levelType: 'Undergraduate',
      level: '300 Level',
    } as any,
  });
  await auth.verifyOtp({ email: DEMO.email, code: server.mail.lastCode(DEMO.email) });

  for (const [role, name] of [
    ['admin', 'Ada Admin'],
    ['creator', 'Chidi Creator'],
    ['reviewer', 'Dr Rita Reviewer'],
  ] as const) {
    await server.createStaff(`${role}@edmira.com`, role, STAFF_PASSWORD, name);
  }

  await server.app.listen(PORT, '0.0.0.0');
  console.log(`
🚀 EdMira backend (in-memory) on http://localhost:${PORT}/api/v1   docs: /api/docs
   Seeded ${seeded.courses} courses, ${seeded.topics} topics, ${seeded.questions} questions, ${seeded.news} news
   Demo student:  ${DEMO.email} / ${DEMO.password}
   Dashboard:     admin@edmira.com · creator@edmira.com · reviewer@edmira.com  (password ${STAFF_PASSWORD})
   Codes for sign-up / password reset are printed below as ✉️ lines.

   Point the app at it (EdMira-MobileApp/src/config/backend.ts → BACKEND.baseURL):
     iOS simulator      http://localhost:${PORT}
     Android emulator   http://10.0.2.2:${PORT}
     Physical phone     http://<this Mac's Wi-Fi IP>:${PORT}
`);

  const stop = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
