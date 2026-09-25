import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RtStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
    constructor(config: ConfigService) {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            secretOrKey: config.getOrThrow<string>('JWT_REFRESH_SECRET'),
            passReqToCallback: true,
        });
    }

    validate(req: Request, payload: any) {
        const authorizationHeader = req.get('Authorization');
        const refreshToken = authorizationHeader?.replace(/^Bearer\s+/i, '').trim() ?? '';
        // Same shape as JwtStrategy, so @GetCurrentUser('userId') works here too.
        return {
            userId: payload.sub,
            email: payload.email,
            userType: payload.userType,
            refreshToken,
        };
    }
}