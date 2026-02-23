import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-apple';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppleStrategy extends PassportStrategy(Strategy, 'apple') {
    constructor(config: ConfigService) {
        super({
            clientID: config.getOrThrow<string>('APPLE_CLIENT_ID'),
            teamID: config.getOrThrow<string>('APPLE_TEAM_ID'),
            keyID: config.getOrThrow<string>('APPLE_KEY_ID'),
            privateKeyString: config.getOrThrow<string>('APPLE_PRIVATE_KEY'), // or privateKeyLocation
            callbackURL: config.getOrThrow<string>('APPLE_CALLBACK_URL'),
            passReqToCallback: false,
            scope: ['name', 'email'],
        });
    }

    async validate(
        accessToken: string,
        refreshToken: string,
        idToken: string,
        profile: any,
        done: Function,
    ): Promise<any> {
        // Apple only sends name/email on first login. 
        // Usually we need to handle this carefully (e.g., verifying idToken).
        // For now, mapping basic profile.
        const user = {
            email: profile.email,
            firstName: profile.name?.firstName || '',
            lastName: profile.name?.lastName || '',
            socialId: profile.id,
            provider: 'apple',
        };
        done(null, user);
    }
}