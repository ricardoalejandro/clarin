package api

import "github.com/gofiber/fiber/v2/middleware/cors"

func browserCORSConfig(origins string) cors.Config {
	return cors.Config{
		AllowOrigins:     origins,
		AllowMethods:     "GET,POST,PUT,DELETE,OPTIONS,PATCH",
		AllowHeaders:     "Origin,Content-Type,Accept,Authorization,Upgrade,Connection,X-Clarin-Service-Proof,If-Match,X-Operation-Id",
		ExposeHeaders:    "X-Content-Version",
		AllowCredentials: true,
	}
}
