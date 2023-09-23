import { Injectable, Request, Response, Res } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { PasswordService } from 'src/password/password.service';
import { JwtService } from '@nestjs/jwt';
import { UserEntity } from 'src/users/entities/user.entity';
import { jwtConstants } from './constants';

// TODO: Do not store JWT token in cookie or local storage??? Store as cookie with 'HTTP only' !
// prevent CSRF XSS.
@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private passwordService: PasswordService,
    private jwtService: JwtService,
  ) {}

  async validateUser(
    username: string,
    password: string,
  ): Promise<null | UserEntity> {
    console.log('[Auth Service]: validate local user');
    console.log('[Auth Service]: username', username, 'password', password);
    const user = await this.usersService.fetchUserByUsername(username);
    console.log('[Auth Service]: User', user);
    if (!user) {
      console.log('[Auth Service]: user not found.');
      return null;
    }
    if (!(await this.passwordService.checkPassword(password, user))) {
      console.log("[Auth Service]: passwords don't match!");
      return null;
    }
    return user;
  }

  login(user: UserEntity): any {
    console.log('[Auth Service]: login user');
    const payload = { username: user.username, userID: user.id };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }

  // Dont know if this should be elsewhere
  async validateToken(token: string): Promise<any> {
    const jwt = require('jsonwebtoken');
    return await jwt.verify(token, jwtConstants.secret);
  }

  school42Login(req: any, res: any): void {
    console.log('[Auth Service]: school42login');
    const user: UserEntity = req.user;
    console.log(user);
    const access_token = this.login(user);
    res.cookie('token', access_token.access_token);
    res.redirect(302, `http://localhost:3000/user/${user.id}`);
  }
}
