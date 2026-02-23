import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { ConfigModule } from '@nestjs/config';

@Module({
    imports: [TerminusModule, ConfigModule],
    controllers: [HealthController],
})
export class HealthModule { }