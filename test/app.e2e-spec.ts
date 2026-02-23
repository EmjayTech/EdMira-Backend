import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';

describe('AuthController (e2e)', () => {
    let app: INestApplication;
    let authToken: string;
    let userEmail = `e2e-test-${Date.now()}@example.com`;

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.setGlobalPrefix('api/v1');
        app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
        await app.init();
    });

    afterAll(async () => {
        await app.close();
    });

    it('/auth/signup (POST) - Success', async () => {
        const response = await request(app.getHttpServer())
            .post('/api/v1/auth/signup')
            .send({
                email: userEmail,
                password: 'Password123!',
                firstName: 'E2E',
                lastName: 'User',
                username: 'e2euser',
                userType: 'STUDENT',
                studentProfile: {
                    institution: 'University of Lagos',
                    faculty: 'Medical Sciences',
                    department: 'Nursing',
                    levelType: 'Undergraduate',
                    level: '500 Level'
                }
            })
            .expect(201);

        expect(response.body).toHaveProperty('message');
        expect(response.body.user).toHaveProperty('email', userEmail);
        expect(response.body.user).not.toHaveProperty('password');
    });

    it('/auth/login (POST) - Fail Unverified', async () => {
        await request(app.getHttpServer())
            .post('/api/v1/auth/login')
            .send({
                email: userEmail,
                password: 'Password123!',
            })
            .expect(401);
    });
});