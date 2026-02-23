import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-microsoft';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MicrosoftStrategy extends PassportStrategy(Strategy, 'microsoft') {
    constructor(config: ConfigService) {
        super({
            clientID: config.getOrThrow<string>('MICROSOFT_CLIENT_ID'),
            clientSecret: config.getOrThrow<string>('MICROSOFT_CLIENT_SECRET'),
            callbackURL: config.getOrThrow<string>('MICROSOFT_CALLBACK_URL'),
            scope: ['user.read'],
        });
    }

    async validate(
        accessToken: string,
        refreshToken: string,
        profile: any,
        done: Function,
    ): Promise<any> {
        const { name, emails, id } = profile;
        const user = {
            email: emails[0].value,
            firstName: name.givenName,
            lastName: name.familyName,
            socialId: id,
            provider: 'microsoft',
            accessToken,
        };
        done(null, user);
    }
}