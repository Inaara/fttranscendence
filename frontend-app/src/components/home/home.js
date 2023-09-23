import  { NavLink } from "react-router-dom";
function Home() {
    return (
		<div>
		<section class="section">
                <div class="box-main">
                    <div class="firstHalf">
                        <h1 class="text-big">
						Let's Play PONG !
                        </h1>
                        <p class="text-small">
						We made a great implementation of Pong you can play here !
                        </p>
                       
                    </div>
                </div>
            </section>
            <section class="section">
                <div class="box-main">
                    <div class="secondHalf">
                        <h1 class="text-big" id="program">
								Let's start playing
                        </h1>
						<li><NavLink to="/login">Login</NavLink></li>
                    </div>
                </div>
            </section>
            <footer className="footer">
                <p className="text-footer">
                    Copyright ©-All rights are reserved
                </p>
            </footer>
        </div>
    )
}

export default Home;
