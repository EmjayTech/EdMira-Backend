import { Body, Controller, Post, UseGuards, HttpCode, HttpStatus, Get, Patch, Req, Ip, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { GetCurrentUser } from '../common/decorators/get-current-user.decorator';
import { RtGuard } from './jwt/rt.guard';
import { AuthService } from './auth.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { ResetPasswordDto } from './dto/rest-password.dto';
import { SignupDto } from './dto/signup.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangeUsernameDto } from './dto/change-username.dto';
import { PrivacyDto } from './dto/privacy.dto';
import { Public } from 'src/common/decorators/public.decorator';
import { Request } from 'express';


@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) { }

  @Public()
  @Post('signup')
  @ApiOperation({ summary: 'Initiate signup — OTP is emailed; account is only created after /verify succeeds' })
  @ApiResponse({ status: 201, description: 'OTP sent. No account is created yet — call /verify with the code to finalize signup.' })
  @ApiResponse({ status: 409, description: 'Email already in use.' })
  signup(@Body() signUp: SignupDto) {
    return this.authService.signup(signUp);
  }

  @Public()
  @Post('verify')
  @ApiOperation({ summary: 'Verify signup OTP and create the user account' })
  @ApiResponse({ status: 201, description: 'OTP verified, account created, access + refresh tokens returned.' })
  @ApiResponse({ status: 400, description: 'Invalid, expired, or missing pending signup OTP.' })
  verify(@Body() otp: VerifyOtpDto) {
    return this.authService.verifyOtp(otp);
  }

  @Public()
  @Post('resend-otp')
  @ApiOperation({ summary: 'Resend OTP to email' })
  @ApiResponse({ status: 201, description: 'OTP resent successfully.' })
  resendOtp(@Body() dto: ResendOtpDto) {
    return this.authService.resendOtp(dto);
  }

  @Public()
  @Post('login')
  @ApiOperation({ summary: 'Log in with email or username (any case) + password' })
  @ApiResponse({ status: 201, description: 'Login successful. Returns access and refresh tokens.' })
  @ApiResponse({ status: 401, description: 'code INVALID_CREDENTIALS — the same reply for any wrong email/username/password.' })
  @ApiResponse({ status: 429, description: 'code LOGIN_LOCKED — 5 failures for this identifier from this IP in 15 minutes.' })
  login(@Body() dto: LoginDto, @Ip() ip: string) {
    return this.authService.login(dto, ip);
  }

  @Public()
  @Get('username-available')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Live username check: { available } or { available: false, reason: invalid | reserved | offensive | taken }' })
  usernameAvailable(@Query('username') username: string) {
    return this.authService.usernameAvailability(username);
  }

  @Patch('username')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change your username (once every 30 days). Returns the updated profile.' })
  @ApiResponse({ status: 400, description: 'USERNAME_INVALID / RESERVED / OFFENSIVE, or USERNAME_CHANGE_TOO_SOON with nextChangeAt.' })
  @ApiResponse({ status: 409, description: 'USERNAME_TAKEN' })
  changeUsername(@GetCurrentUser('userId') userId: string, @Body() dto: ChangeUsernameDto) {
    return this.authService.changeUsername(userId, dto);
  }

  @Post('logout')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Log out user' })
  @ApiResponse({ status: 200, description: 'Logout successful.' })
  @HttpCode(HttpStatus.OK)
  logout(@GetCurrentUser('userId') userId: string, @Req() req: Request) {
    // Extract access token for blacklisting
    const accessToken = req.get('Authorization')?.replace(/^Bearer\s+/i, '').trim();
    return this.authService.logout(userId, accessToken);
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Returns user profile.' })
  // Not cached: a fixed cache key would serve one user's profile to others.
  getProfile(@GetCurrentUser('userId') userId: string) {
    return this.authService.getFullProfile(userId);
  }

  @Patch('profile')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update name and academic info of the current user' })
  @ApiResponse({ status: 200, description: 'Returns the updated profile.' })
  updateProfile(@GetCurrentUser('userId') userId: string, @Body() dto: UpdateProfileDto) {
    return this.authService.updateProfile(userId, dto);
  }

  @Patch('privacy')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update privacy settings (e.g. showOnLeaderboard). Returns the updated profile.' })
  updatePrivacy(@GetCurrentUser('userId') userId: string, @Body() dto: PrivacyDto) {
    return this.authService.updatePrivacy(userId, dto);
  }

  @Public()
  @UseGuards(RtGuard)
  @Post('refresh')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'Tokens refreshed.' })
  @HttpCode(HttpStatus.OK)
  refreshTokens(
    @GetCurrentUser('userId') userId: string,
    @GetCurrentUser('refreshToken') refreshToken: string,
  ) {
    return this.authService.refreshTokens(userId, refreshToken);
  }

  @Public()
  @Post('forgot-password')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Email a reset code — accepts email or username; same reply either way' })
  @ApiResponse({ status: 201, description: 'Reset code sent.' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Public()
  @Post('reset-password')
  @ApiOperation({ summary: 'Reset password' })
  @ApiResponse({ status: 200, description: 'Password reset successful.' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }
}